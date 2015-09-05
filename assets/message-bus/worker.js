(() => {
  "use strict";

  const MessageBusRegex = /\/message-bus\/([0-9a-f]{32})\/poll\?(dlp=t)?$/;
  self.addEventListener('fetch', (evt) => {
    // TODO - optimize? this runs a lot
    if (evt.request.url.endsWith('/message-bus/settings.json')) {
      // Update the message bus settings
      evt.request.text().then(function (reqText) {
        const kvPairs = parseForm(reqText);
        kvPairs.forEach((a) => settings[a.k] = a.v);
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

  const uniqueId = 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    /*eslint-disable*/
    var r, v;
    r = Math.random() * 16 | 0;
    v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
    /*eslint-enable*/
  });

  const settings = {
    baseUrl: '/',
    shared_session_key: '',
  };

  // activeClients[clientId] = MBClient
  const activeClients = {};

  // backlog[channel] = {
  //   last: position [Number],
  //   lastRequested: timestamp [Number],
  //   messages: [Array], // in order, lowest position first
  // }
  const backlog = {};
  let currentRequest;
  let lastSuccess = 0;
  let lastClientCount = 0;
  const MIN_REQUEST_INTERVAL = 100,
    CHANNEL_UNSUB_TIMEOUT = 1000 * 60,
    CLIENT_FAILSAFE_TIMEOUT = 1000 * 60,
    NETWORK_DELAY = 1000 * 2;

  function objEach(obj, cb) {
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        cb(key, obj[key]);
      }
    }
  }

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
    return new Response('[]', {
      status: 504,
      statusText: 'Network Timed Out'
    });
  }

  function cancelledResponse() {
    return new Response('', {
      status: 400,
      statusText: 'Request Cancelled'
    });
  }

  function MBClient(clientId) {
    this.clientId = clientId;
    this.subscriptions = {};
  }

  MBClient.prototype.subscribe = function (chan, last_position) {
    this.subscriptions[chan] = last_position;
  }

  MBClient.prototype.eachSubscription = function (cb) {
    objEach(this.subscriptions, cb);
  }

  MBClient.prototype.hasData = function () {
    let found = false;
    this.eachSubscription((channel, position) => {
      if (backlog[channel]) {
        const entry = backlog[channel];
        if (entry.last > position) {
          found = true;
        }
      }
    });
    return found;
  }

  MBClient.prototype.makePromise = function () {
    const clientSelf = this;
    const promise = new Promise(function (resolve, reject) {
      clientSelf.resolve = resolve;
      clientSelf.reject = reject;
      clientSelf.interval = setTimeout(() => {
        console.error('Bus timed out! cid:', clientSelf.clientId);
        resolve(timeoutResponse());
      }, CLIENT_FAILSAFE_TIMEOUT);
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

  MBClient.prototype.respond = function() {
    this.resolve(this.respondNow());
  }

  MBClient.prototype.respondNow = function () {
    delete activeClients[this.clientId];
    const status = {};
    let includeStatusChannel = false;
    const messages = [];
    this.eachSubscription((channel, position) => {
      const entry = backlog[channel];
      if (!entry) return;

      if (position === -1) {
        status[channel] = entry.last;
        includeStatusChannel = true;
      } else {
        entry.messages.forEach((m) => {
          if (m.message_id > position) {
            messages.push(m);
          }
        });
      }
    });

    if (includeStatusChannel) {
      messages.push({
        message_id: -1,
        global_id: -1,
        channel: '/__status',
        data: status
      });
    }

    messages.sort((m1, m2) => m2.global_id - m1.global_id);
    console.log("Responding to bus client " + this.clientId + " with " + messages.length + " messages");

    const response = new Response(JSON.stringify(messages));
    return response;
  }

  function serveMessageBus(fetchEvt, clientId) {
    if (activeClients[clientId]) {
      // TODO aborting fetches https://github.com/whatwg/fetch/issues/27
      console.log('Cancelled previous reqeust for ' + clientId);
      activeClients[clientId].resolve(cancelledResponse());
      delete activeClients[clientId];
    }
    const client = new MBClient(clientId);

    fetchEvt.respondWith(
      // XXX - request.formData() not available
      fetchEvt.request.text().then((bodyText) => {
        const kvPairs = parseForm(bodyText);
        kvPairs.forEach((reg) => {
          client.subscribe(reg.k, parseInt(reg.v));
        });
        return null;
      }).then(() => {
        if (client.hasData()) {
          console.log('Returned instant data for ' + clientId);
          return client.respondNow();
        } else {
          console.log('Queuing up message bus client ' + clientId);
          return client.makePromise();
        }
      })
    );

    setTimeout(ensureRequestActive, MIN_REQUEST_INTERVAL * 2);
  }

  function ensureRequestActive() {
    var clientCount = 0;
    objEach(activeClients, () => clientCount++);
    if (clientCount > 0 && !currentRequest) {
      restartPolling();
    }
  }

  let pollDelayInterval = -1;
  let lastPollRequest = {};

  function delayPolling(delay) {
    if (pollDelayInterval < 0) {
      pollDelayInterval = setTimeout(() => {
        pollDelayInterval = -1;
        restartPolling();
      }, delay);
    }
  }

  function waitingForClients() {
    setTimeout(() => {
      if (currentRequest == null) {
        lastClientCount = 0;
        delayPolling(MIN_REQUEST_INTERVAL);
      }
    }, MIN_REQUEST_INTERVAL * 5);
  }

  function restartPolling() {
    if (!navigator.onLine) {
      return delayPolling(NETWORK_DELAY);
    }
    const now = new Date().getTime();
    let timeSinceLast = now - lastSuccess;
    if (timeSinceLast < MIN_REQUEST_INTERVAL) {
      return delayPolling(MIN_REQUEST_INTERVAL * 2);
    }

    pollDelayInterval = -1;
    const lowestPosition = {};
    let clientNum = 0;

    objEach(activeClients, (cid, client) => {
      if (client.hasData()) {
        client.respond();
      } else {
        clientNum++;
        client.eachSubscription((channel, position) => {
          if (lowestPosition[channel] === undefined) {
            lowestPosition[channel] = position;
          } else {
            if (lowestPosition[channel] > position) {
              lowestPosition[channel] = position;
            }
          }
        });
      }
    });

    if (clientNum < lastClientCount) {
      console.log('have ' + clientNum + ' waiting, but had ' + lastClientCount + ' last time');
      return waitingForClients();
    }

    objEach(lowestPosition, (channel) => {
      if (backlog[channel]) {
        backlog[channel].lastRequested = now;
      }
    });

    objEach(backlog, (channel, entry) => {
      if (lowestPosition[channel] === undefined) {
        if (entry.lastRequested > now - CHANNEL_UNSUB_TIMEOUT) {
          lowestPosition[channel] = entry.last;
        }
      }
    });

    if (currentRequest) {
      let requestsEqual = true;
      objEach(lowestPosition, (channel, position) => {
        if (lastPollRequest[channel] !== position) {
          requestsEqual = false;
        }
      });
      objEach(lastPollRequest, (channel, position) => {
        if (lowestPosition[channel] !== position) {
          requestsEqual = false;
        }
      });

      if (requestsEqual) {
        console.log('Skipping - same as active request');
        return;
      }
    }

    lastPollRequest = lowestPosition;

    const formParts = [];
    let logString = '';
    objEach(lowestPosition, (channel, position) => {
      formParts.push(encodeURIComponent(channel) + '=' + encodeURIComponent(position));
      logString = logString + channel + '=' + position + "\n";
    });

    // XXX - cannot abort fetch
    const headers = new Headers();
    headers.set('X-SILENCE-LOGGER', 'true');
    if (settings.shared_session_key) {
      headers.set('X-Shared-Session-Key', settings.shared_session_key);
    }
    headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');

    const opts = {
      method: 'POST',
      headers: headers,
      body: formParts.join('&'),
      cache: 'no-store',
    }
    console.log(`Making bus request for ${clientNum} clients`);
    let thisRequest = fetch(`${settings.baseUrl}message-bus/${uniqueId}/poll`, opts).then((response) => {
      lastSuccess = new Date().getTime();
      return response.json();
    }).then(json => {
      // json is array of objects
      /*
      { channel: '/__status',
        data: {
          // Position map
        },
        global_id: -1,
        message_id: -1,
      }
       */

      // Fill backlog
      // TODO need a flush message
      json.forEach(function(message) {
        if (message.channel === "/__status") {
          objEach(message.data, (channel, position) => {
            setBacklogPosition(channel, position);
          });
        } else {
          pushBacklogMessage(message.channel, message);
        }
      });
    }).then(() => {
      if (currentRequest !== thisRequest) {  // TODO aborting fetches
        throw "cancelled";
      }
      objEach(activeClients, (_, client) => {
        client.respond();
      });
    }).then(() => {
      currentRequest = null;
      lastClientCount = clientNum;
    }).catch((err) => {
      if (err === "cancelled") {  // TODO aborting fetches
        console.log('Cancelled bus request completed');
        ensureRequestActive();
        return;
      } else {
        console.error(err);
        currentRequest = null;
        delayPolling(NETWORK_DELAY);
      }
    });
    currentRequest = thisRequest; // TODO aborting fetches - https://github.com/whatwg/fetch/issues/27
  }

  function parseForm(text) {
    const result = [];
    text.split('&').forEach(function (part) {
      const keyValue = part.split('=');
      result.push({k: decodeURIComponent(keyValue[0]), v: decodeURIComponent(keyValue[1])});
    });
    return result;
  }
})();
