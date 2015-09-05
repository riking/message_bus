(function (self) {
  "use strict";

  const MessageBusRegex = /\/message-bus\/([0-9a-f]{32})\/poll\??$/;
  const uniqueId = 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    /*eslint-disable*/
    var r, v;
    r = Math.random() * 16 | 0;
    v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
    /*eslint-enable*/
  });

  function objEach(obj, cb) {
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        cb(key, obj[key]);
      }
    }
  }

  const settings = {
    baseUrl: '/',
    shared_session_key: '',
  };

  // clients[clientId] = Client
  const clients = {};

  // backlog[channel] = {
  //   last: position [Number],
  //   messages: [Array], // in order, lowest position first
  // }
  const backlog = {};
  let currentRequest;
  let lastSuccess = 0;
  const MIN_REQUEST_INTERVAL = 1000;

  function setBacklogPosition(channel, position) {
    backlog[channel] = {
      last: position,
      messages: []
    };
  }

  function pushBacklogMessage(channel, message) {
    if (!backlog[channel]) {
      backlog[channel] = { last: message.message_id, messages: [] };
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

  self.addEventListener('install', () => {
    console.log('mb installing');
  });

  self.addEventListener('fetch', (evt) => {
    //console.log('got request for', evt.request.url);

    if (evt.request.url.endsWith('settings.json')) {
      console.log('got settings request!');
      evt.request.text().then(function (reqText) {
        const kvPairs = parseForm(reqText);
        kvPairs.forEach((a) => settings[a.k] = a.v);
      });
      evt.respondWith(new Response('ok'));
      return;
    } else {
      let match = MessageBusRegex.exec(evt.request.url);
      if (match) {
        serveMessageBus(evt, match[1]);
      }
    }
  });

  function timeoutResponse() {
    return new Response('[]', {
      status: 504,
      statusText: 'Network Timed Out'
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
    this.eachSubscription((subName, position) => {
      if (backlog[subName]) {
        const entry = backlog[subName];
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
        console.log('Bus timed out! cid:', clientSelf.clientId);
        resolve(timeoutResponse());
      }, 1000 * 60);
      if (!currentRequest) {
        restartPolling();
      }
    });
    const myClear = (v) => {
      clearTimeout(clientSelf.interval);
      return v;
    };
    promise.then(myClear, myClear);
    return promise;
  }

  MBClient.prototype.respond = function() {
    console.log("Responding to message bus client " + this.clientId);
    this.resolve(this.respondNow());
  }

  MBClient.prototype.respondNow = function () {
    delete clients[this.clientId];
    const status = {};
    let includeStatusChannel = false;
    const messages = [];
    this.eachSubscription((subName, position) => {
      const entry = backlog[subName];
      if (!entry) return;

      if (position === -1) {
        status[subName] = entry.last;
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
    debugger;

    const response = new Response(JSON.stringify(messages));
    return response;
  }

  function serveMessageBus(fetchEvt, clientId) {
    if (clients[clientId]) {
      console.log('Cancelled previous reqeust for ' + clientId);
      clients[clientId].reject(); // cancel previous request
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
          clients[clientId] = client;
          return client.makePromise();
        }
      })
    );
  }

  let pollDelayInterval = -1;

  function delayPolling(delay) {
    if (pollDelayInterval >= 0) {
      pollDelayInterval = setTimeout(() => {
        pollDelayInterval = -1;
        restartPolling();
      }, delay);
    }
  }

  function restartPolling() {
    if (!navigator.onLine) {
      return delayPolling(2000);
    }
    let timeSinceLast = new Date().getTime() - lastSuccess;
    if (timeSinceLast < MIN_REQUEST_INTERVAL) {
      return delayPolling(MIN_REQUEST_INTERVAL + 1);
    }

    pollDelayInterval = -1;

    // XXX - cannot abort fetch
    const headers = new Headers();
    headers.set('X-SILENCE-LOGGER', 'true');
    if (settings.shared_session_key) {
      headers.set('X-Shared-Session-Key', settings.shared_session_key);
    }
    const lowestPosition = {};
    let clientNum = 0;
    const myClients = {};

    objEach(clients, (cid, client) => {
      myClients[cid] = client;
      clientNum++;
      client.eachSubscription((subName, position) => {
        if (lowestPosition[subName] === undefined) {
          lowestPosition[subName] = position;
        } else {
          if (lowestPosition[subName] > position) {
            lowestPosition[subName] = position;
          }
        }
      });
    });

    const formParts = [];
    let logString = '';
    objEach(lowestPosition, (subName, position) => {
      formParts.push(encodeURIComponent(subName) + '=' + encodeURIComponent(position));
      logString += subName + '=' + position + "\n";
    });

    headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');

    const opts = {
      method: 'POST',
      headers: headers,
      body: formParts.join('&'),
      cache: 'no-store',
    }
    console.log(`Making bus request for ${clientNum} clients`);
    let thisRequest = fetch(`${settings.baseUrl}message-bus/${uniqueId}/poll`, opts).then((response) => {
      if (currentRequest !== thisRequest) {
        throw "cancelled";
      }
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
      objEach(myClients, (_, client) => {
        client.respond();
      });
    }).then(() => {
      currentRequest = null;
    }).catch((err) => {
      if (err === "cancelled") {
        console.log('Cancelled bus request completed');
        return;
      }
      console.error(err);
      currentRequest = null;
    });
    currentRequest = thisRequest;
  }

  function parseForm(text) {
    const result = [];
    text.split('&').forEach(function (part) {
      const keyValue = part.split('=');
      result.push({k: decodeURIComponent(keyValue[0]), v: decodeURIComponent(keyValue[1])});
    });
    return result;
  }
})(self);