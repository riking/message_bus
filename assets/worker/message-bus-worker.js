(() => {
  "use strict";

  self.MB_DEBUG = false;
  console.info('Set self.MB_DEBUG = true to see debug messages');

  // TODO - handle every query param
  // dlp=t - disable long polling
  // worker=f - do not handle through serviceworker
  // currently, dlp=t is ignored and worker=f causes a match failure
  const MessageBusRegex = /\/message-bus\/([0-9a-f]{32})\/poll\?(dlp=t)?$/;

  self.addEventListener('fetch', (evt) => {
    // TODO - optimize? this runs a lot
    if (evt.request.url.endsWith('/message-bus/settings.json')) {
      // Update the message bus settings
      evt.request.basicUrlForm().then(function (formData) {
        objEach(formData, (k,v) => {
          const existing = settings[k];
          if (typeof existing === "string") {
            settings[k] = v;
          } else if (typeof existing === "number") {
            settings[k] = parseInt(v);
          }
        });
      });
      evt.respondWith(new Response('ok'));
      return;
    } else {
      let match = MessageBusRegex.exec(evt.request.url);
      if (match) {
        // Intercept & serve
        serveMessageBus(evt, match[1]);
      }
    }
  });

  // Global Variables

  const settings = {
    baseUrl: '/',
    shared_session_key: '',
    long_polling_interval: 25000,
  };

  // activeClients = [Object: Mapping]
  //   activeClients[clientId] = MBClient
  const activeClients = {};

  // backlog = [Object: Mapping]
  // backlog[channel] = {
  //   last: position [Number],
  //   lastRequested: [Number: Timestamp],
  //   messages: [Array], // in order, lowest position first
  // }
  const backlog = {};

  // currentRequest = [null] | {
  //   // The promise from fetch() after all the .then() chains
  //   fetchPromise: [Promise]
  //   // The data (subscriptions) sent to the server
  //   sentData: [Object] channel: position
  //   // The number of activeClients when the request was sent
  //   clientNum: [Number]
  //   // Call this to cancel the request
  //   // TODO aborting fetches (right now we throw away the result)
  //   cancelFunc: [Function]
  //   // Time when the request was sent
  //   startedAt: [Number: Timestamp]
  // }
  let currentRequest = null;

  // lastSuccess = [Object]
  //   // Time when request finished successfully
  //   time: [Number: Timestamp]
  //   // The number of clients serviced by the request when it finished
  //   clientCount: [Number]
  let lastSuccess = {
    time: 0,
    clientCount: 0
  };

  // [Number] count of bus requests sent to the server.
  let requestIdCount = 1;
  // [Number: setTimeout] return from setTimeout() for restartPolling()
  let pollDelayInterval = -1;
  // [Number: Timestamp] timestamp of the first restartPolling() call AFTER the currentRequest started
  let pollRequestedAt = 0;

  // Constants

  // (ms) Two bus requests will never be sent any closer together than this
  const MIN_REQUEST_INTERVAL = 100,
    // (ms) Time to keep asking the server for a channel even though no clients use it
    CHANNEL_KEEP_TIME = 1000 * 60,
    // (ms) Time to wait for a response from the serviceWorker before declaring it broken
    // TODO needs to be adjusted based on long_polling_interval
    CLIENT_FAILSAFE_TIMEOUT = 25000 * 2.4,
    // (ms) Time to allow clients to send their bus requests before sending ours
    WAITING_FOR_CLIENTS_TIMEOUT = 1000 * 3,
    // (ms) Time to wait before sending an empty response
    // TODO needs to be adjusted based on long_polling_interval
    NO_RESPONSE_DELAY = 25000,
    // (ms) Time to wait before sending bus request if browser is offline
    // TODO needs to be adjusted based on long_polling_interval
    EVEN_IF_OFFLINE_TIMEOUT = CLIENT_FAILSAFE_TIMEOUT - 25000 - 5000;

  const uniqueId = 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    /*eslint-disable*/
    var r, v;
    r = Math.random() * 16 | 0;
    v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
    /*eslint-enable*/
  });

  // Library Functions / Polyfills

  function objEach(obj, cb) {
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        cb(key, obj[key]);
      }
    }
  }

  {
    const basicUrlForm = function () {
      return this.text().then(function (text) {
        const result = {};
        text.split('&').forEach(function (part) {
          const keyValue = part.split('=');
          result[decodeURIComponent(keyValue[0])] = decodeURIComponent(keyValue[1]);
        });
        return result;
      });
    }

    Request.prototype.basicUrlForm = basicUrlForm;
    Response.prototype.basicUrlForm = basicUrlForm;
  }

  function debugLog(message) {
    if (self.MB_DEBUG) {
      console.debug(message);
    }
  }

  // Utility Functions

  function setBacklogPosition(channel, position) {
    backlog[channel] = {
      last: position,
      messages: []
    };
  }

  function pushBacklogMessage(channel, message) {
    if (!backlog[channel]) {
      backlog[channel] = { last: message.message_id, messages: [message] };
      return;
    }
    const messageId = message.message_id;
    const messageAry = backlog[channel].messages;
    let messageExists = !messageAry.every((m) => {
      if (m.message_id === messageId) {
        return false;
      }
      return true;
    });
    if (!messageExists) {
      messageAry.push(message);
      if (messageId > backlog[channel].last) {
        backlog[channel].last = messageId;
      }
    }
  }

  function timeoutResponse() {
    return new Response('[{"message_id":-1,"global_id":-1,"channel":"/__worker_broken","data":null}]', {
      status: 504,
      statusText: 'ServiceWorker Timed Out'
    });
  }

  function cancelledResponse() {
    return new Response('[INVALID JSON]', {
      status: 400,
      statusText: 'Request Cancelled'
    });
  }

  // Class: MBClient

  function MBClient(clientId) {
    this.clientId = clientId;
    this.subscriptions = {};
    this.resolve = null;
    this.reject = null;
    this.interval = null;
    this.startedAt = null;
    this.flushed = false;
  }

  MBClient.prototype.subscribe = function (chan, last_position) {
    this.subscriptions[chan] = last_position;
  }

  MBClient.prototype.eachSubscription = function (cb) {
    objEach(this.subscriptions, cb);
  }

  MBClient.prototype.hasData = function () {
    for (let channel in this.subscriptions) {
      if (this.subscriptions.hasOwnProperty(channel)) {
        const position = this.subscriptions[channel];
        if (backlog[channel]) {
          const entry = backlog[channel];
          if (entry.last > position) {
            return true;
          }
        }
      }
    }
    return false;
  }

  MBClient.prototype.makePromise = function () {
    const clientSelf = this;
    const promise = new Promise(function (resolve, reject) {
      clientSelf.resolve = resolve;
      clientSelf.reject = reject;

      // Failsafe if the worker polling breaks
      clientSelf.interval = setTimeout(() => {
        console.error('Bus timed out! cid:', clientSelf.clientId);
        resolve(timeoutResponse());
      }, CLIENT_FAILSAFE_TIMEOUT);

      clientSelf.startedAt = new Date().getTime();

      // Add to activeClients, call restartPolling()
      activeClients[clientSelf.clientId] = clientSelf;
      restartPolling();
    });
    const myClear = (v) => {
      clearTimeout(clientSelf.interval);
      return v;
    };
    promise.then(myClear, myClear);
    return promise;
  }

  MBClient.prototype.__flush = function() {
    this.flushed = true;
  }

  MBClient.prototype.shouldRespond = function(now) {
    if (this.hasData()) {
      return true;
    }
    if (this.startedAt && now - this.startedAt > NO_RESPONSE_DELAY) {
      // Return an empty response if it's been longer than NO_RESPONSE_DELAY
      return true;
    }
    return false;
  }

  MBClient.prototype.respond = function() {
    this.resolve(this.respondNow());
  }

  MBClient.prototype.respondNow = function () {
    // TODO - find a way to not respond if nothing to send and it hasn't been very long
    delete activeClients[this.clientId];
    const status = {};
    let includeStatusChannel = false;
    const messages = [];
    const flushed = this.flushed;

    this.eachSubscription((channel, position) => {
      const entry = backlog[channel];
      if (!entry) return;

      if (flushed || position === -1) {
        status[channel] = entry.last;
        includeStatusChannel = true;
      } else if (position < entry.last) {
        entry.messages.forEach((m) => {
          if (m.message_id > position) {
            messages.push(m);
          }
        });
      }
    });

    if (flushed) {
      messages.push({
        message_id: -1,
        global_id: -1,
        channel: '/__flush',
        data: null
      });
    }
    if (includeStatusChannel) {
      messages.push({
        message_id: -1,
        global_id: -1,
        channel: '/__status',
        data: status
      });
    }

    if (!flushed) {
      messages.sort((m1, m2) => m2.global_id - m1.global_id);
    }
    debugLog("MB: Responding to bus client " + this.clientId + " with " + messages.length + " messages");

    const response = new Response(JSON.stringify(messages));
    return response;
  }

  // Bus Polling functions

  function serveMessageBus(fetchEvt, clientId) {
    if (activeClients[clientId]) {
      debugLog('MB: Cleared aborted request from ' + clientId);
      activeClients[clientId].resolve(cancelledResponse());
      delete activeClients[clientId];
    }

    const client = new MBClient(clientId);

    fetchEvt.respondWith(
      fetchEvt.request.basicUrlForm().then((formData) => {
        objEach(formData, (channel, position) => {
          client.subscribe(channel, parseInt(position));
        });
      }).then(() => {
        if (client.hasData()) {
          return client.respondNow();
        } else {
          debugLog('MB: Queuing up message bus client ' + clientId);
          return client.makePromise();
        }
      })
    );

    setTimeout(ensureRequestActive, MIN_REQUEST_INTERVAL * 2);
  }

  function ensureRequestActive() {
    if (currentRequest === null && pollDelayInterval === -1) {
      restartPolling();
    }
  }

  function nowonline() {
    clearTimeout(pollDelayInterval);
    removeEventListener('online', nowonline);
    restartPolling();
  }

  function restartPolling() {
    // Conditions:
    //  1) if it's been less than MIN_REQUEST_INTERVAL since the last request started, wait for MIN_REQUEST_INTERVAL
    //  2) if less (or 0) clients signed up than last time, wait for WAITING_FOR_CLIENTS_TIMEOUT
    //  3) if the browser is offline, restart when we get online or after EVEN_IF_OFFLINE_TIMEOUT
    //  4) if we have no clients, don't send the request
    //  5) if a request is running and we have the same data to send, do nothing
    //
    // Actions:
    //  1) if any client has data in the backlog, respond (and wait for WAITING_FOR_CLIENTS_TIMEOUT)
    //     (this needs to happen before the reschedule)
    //  2) if a channel has been requested in the last CHANNEL_KEEP_TIME but it's not here now, include it
    //  3) save channel last requested times
    //  4) if more channels have been added, cancel previous request
    //  5) if pollDelayInterval is running, cancel it
    //  6) if we have no subscribed channels, stop polling
    //  7) send the request
    //
    // Behavior:
    //  - setup
    //  - conditions 1-3, action 1
    //  - if a condition is not met, reschedule
    //  - determine channels to request
    //  - condition 4, actions 2-3
    //  - condition 5, action 4
    //  - actions 5-7
    //  - send

    // setup
    let _delayFor = 0;
    const delayFor = (duration) => {
      if (duration > _delayFor) {
        _delayFor = duration;
      }
    };
    const now = new Date().getTime();
    if (pollRequestedAt === 0) {
      pollRequestedAt = now;
    }

    //  1) if it's been less than MIN_REQUEST_INTERVAL since the last request started, wait MIN_REQUEST_INTERVAL
    if (currentRequest && now - currentRequest.startedAt < MIN_REQUEST_INTERVAL) {
      delayFor(MIN_REQUEST_INTERVAL);
    }

    let clientNum = 0;
    objEach(activeClients, (cid, client) => {
      if (client.hasData()) {
        //  1) if any client has data in the backlog, respond (and wait for WAITING_FOR_CLIENTS_TIMEOUT)
        client.respond();
        delayFor(WAITING_FOR_CLIENTS_TIMEOUT);
      } else {
        clientNum++;
      }
    });

    //  2) if less (or 0) clients signed up than last time, wait for WAITING_FOR_CLIENTS_TIMEOUT
    if (clientNum === 0 || clientNum < lastSuccess.clientCount) {
      delayFor(WAITING_FOR_CLIENTS_TIMEOUT);
    }

    //  3) if the browser is offline, restart when we get online or after EVEN_IF_OFFLINE_TIMEOUT
    if (!navigator.onLine) {
      delayFor(EVEN_IF_OFFLINE_TIMEOUT);
    }

    // if a condition is not met, reschedule
    if (_delayFor > 0) {
      const targetTime = pollRequestedAt + _delayFor;
      if (targetTime > now) {
        clearTimeout(pollDelayInterval);
        pollDelayInterval = setTimeout(restartPolling, targetTime - now + 10);
        if (!navigator.onLine) {
          // nb: duplicate listeners discarded
          addEventListener('online', nowonline);
        }

        debugLog('MB: delaying for ' + _delayFor + ': settimeout(' + (targetTime - now) + ')');
        return; // pollDelayInterval
      }
    }

    pollRequestedAt = 0;
    noDelayDoPolling();
  }

  function noDelayDoPolling() {
    const now = new Date().getTime();

    // determine channels to request
    const requestPositions = {};
    const clientIds = [];

    objEach(activeClients, (cid, client) => {
      clientIds.push(cid);
      client.eachSubscription((channel, position) => {
        if (requestPositions[channel] === undefined) {
          requestPositions[channel] = position;
        } else {
          // How do we combine the positions?
          // Consider: There may be messages that one client got but not another
          // If a client had messages to see, it would have been responded to in Action 1 above
          // therefore, we should use the HIGHEST position
          if (requestPositions[channel] < position) {
            requestPositions[channel] = position;
          }
        }
      });
    });

    //  4) if we have no clients, don't send the request
    if (clientIds.length === 0) {
      debugLog("MB: Not sending bus request - no clients");
      return; // stop
    }

    // 2) if a channel has been requested in the last CHANNEL_KEEP_TIME but it's not here now, include it
    objEach(backlog, (channel, entry) => {
      if (requestPositions[channel] === undefined) {
        if (entry.lastRequested > now - CHANNEL_KEEP_TIME) {
          requestPositions[channel] = entry.last;
        }
      }
    });

    // 3) save channel last requested times
    objEach(requestPositions, (channel) => {
      if (backlog[channel]) {
        backlog[channel].lastRequested = now;
      }
    });

    if (currentRequest) {
      // 5) if a request is running and we have the same data to send, do nothing
      // 4) if more channels have been added, cancel previous request
      const lastPollRequest = currentRequest.sentData;
      let requestsEqual = true;
      let channelAdded = false;
      objEach(requestPositions, (channel, position) => {
        if (lastPollRequest[channel] === undefined) {
          channelAdded = true;
          requestsEqual = false;
        } else if (lastPollRequest[channel] !== position) {
          requestsEqual = false;
        }
      });
      objEach(lastPollRequest, (channel, position) => {
        if (requestPositions[channel] !== position) {
          requestsEqual = false;
        }
      });

      if (requestsEqual) {
        debugLog('MB: Requests are equal - skipping');
        return; // currentRequest
      }
      if (channelAdded) {
        debugLog(`MB: Cancelling request #${currentRequest.debugRequestId}`);
        currentRequest.cancelFunc();
        currentRequest = null;
      } else {
        // A channel was removed or moved up
        debugLog('MB: Requests are almost equal - skipping');
        return; // currentRequest
      }
    }

    // 5) if pollDelayInterval is running, cancel it
    clearTimeout(pollDelayInterval);

    // 6) if we have no subscribed channels, stop polling
    let haveAny = false;
    objEach(requestPositions, () => haveAny = true);
    if (!haveAny) {
      debugLog("MB: Not sending bus request - no subscribed channels");
      return; // stop
    }

    // 7) send the request
    doPolling(requestPositions, clientIds);
  }

  function doPolling(positions, clientIds) {
    const formParts = [];
    let logString = '';
    objEach(positions, (channel, position) => {
      formParts.push(encodeURIComponent(channel) + '=' + encodeURIComponent(position));
      logString = logString + channel + '=' + position + "\n";
    });

    const headers = new Headers();
    const opts = {
      method: 'POST',
      headers: headers,
      body: formParts.join('&'),
      cache: 'no-store',
      credentials: 'include'
    };

    headers.set('X-SILENCE-LOGGER', 'true');
    if (settings.shared_session_key !== '') {
      headers.set('X-Shared-Session-Key', settings.shared_session_key);
      opts.mode = 'cors';
    }
    headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
    // headers.set('Bus-Client-IDs', clientIds.join(','));

    // TODO aborting fetches
    let cancelled = false;
    function cancel() {
      cancelled = true;
    }

    const debugRequestId = requestIdCount;
    requestIdCount = requestIdCount + 1;

    debugLog(`MB: Sending message bus request #${debugRequestId} for ${clientIds.join(',')}`);
    let thisRequest = fetch(`${settings.baseUrl}message-bus/${uniqueId}/poll`, opts).then((response) => {
      return response.json();
    }).then(json => {
      // json is array of messages
      /*
      [Message]
      { channel: '/__status',
        data: {
          // Position map
        },
        global_id: -1,
        message_id: -1,
      }
       */

      // Fill backlog with messages from server
      json.forEach(function(message) {
        if (message.channel === "/__status") {
          objEach(message.data, (channel, position) => {
            setBacklogPosition(channel, position);
          });
        } else if (message.channel === "/__flush") {
          // Wipe backlog
          objEach(backlog, (channel) => {
            delete backlog[channel];
          });
          // Mark clients to send flush message
          objEach(activeClients, (_, client) => {
            client.__flush();
          });
        } else {
          pushBacklogMessage(message.channel, message);
        }
      });
    }).then(() => {
      // TODO aborting fetches
      if (cancelled) {
        throw "cancelled";
      }

      var finalClientCount = 0;
      //let anyEmpty = false;
      const now = new Date().getTime();
      // Fulfill the network requests
      objEach(activeClients, (_, client) => {
        finalClientCount++;
        if (client.shouldRespond(now)) {
          client.respond();
        } else {
          //anyEmpty = true;
        }
      });

      debugLog(`MB: Bus request #${debugRequestId} completed`);
      lastSuccess = {
        time: now,
        clientCount: finalClientCount
      };

      if (currentRequest.debugRequestId === debugRequestId) {
        currentRequest = null;
        setTimeout(restartPolling, WAITING_FOR_CLIENTS_TIMEOUT * 0.9);
      }
    }).catch((err) => {
      // TODO aborting fetches
      if (err === "cancelled") {
        debugLog(`MB: Cancelled bus request #${debugRequestId} completed`);
      } else {
        console.error(err);
      }

      if (!currentRequest || currentRequest.debugRequestId === debugRequestId) {
        currentRequest = null;
        setTimeout(restartPolling, WAITING_FOR_CLIENTS_TIMEOUT * 0.9);
      }
    });

    // TODO aborting fetches - https://github.com/whatwg/fetch/issues/27
    currentRequest = {
      fetchPromise: thisRequest,
      sentData: positions,
      clientNum: clientIds.length,
      cancelFunc: cancel,
      startedAt: new Date().getTime(),
      debugRequestId: debugRequestId,
    };
  }
})();