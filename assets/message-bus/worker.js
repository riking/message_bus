"use strict";

const MessageBusRegex = /\/message-bus\/([0-9a-f]{32})\/poll\??$/;
const uniqueId = 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
  /*eslint-disable*/
  var r, v;
  r = Math.random() * 16 | 0;
  v = c === 'x' ? r : (r & 0x3 | 0x8);
  return v.toString(16);
  /*eslint-enable*/
});

self.addEventListener('install', function(evt) {
  console.log('mb installing');
});

self.addEventListener('fetch', function(evt) {
  //console.log('got request for', evt.request.url);

  if (evt.request.url.endsWith('settings.json')) {
    console.log('got settings request!');
    evt.respondWith(new Response('ok'));
    return;
  } else {
    let match = MessageBusRegex.exec(evt.request.url);
    if (match) {
      console.log('captured bus request');
      serveMessageBus(evt, match[1]);
    }
  }
});

// clients[clientId] = Client
const clients = {};
// backlog[channel] = {
//   start: position [Number],
//   last: position [Number],
//   data: [Array],
// }
const backlog = {};
let currentRequest;

function Client(clientId) {
  this.clientId = clientId;
  this.subscriptions = {};
}

Client.prototype.subscribe = function(chan, last_position) {
  this.subscriptions[chan] = last_position;
}

Client.prototype.hasData = function() {
  for (let subName in this.subscriptions) {
    if (backlog[subName]) {
      const entry = backlog[subName];
      if (entry.last > this.subscriptions[subName]) {
        return true;
      }
    }
  }
  return false;
}

Client.prototype.makePromise = function() {
  const self = this;
  return new Promise(function(resolve, reject) {
    self.resolve = resolve;
    self.reject = reject;
    if (!currentRequest) {
      restartPolling();
    }
  });
}

function serveMessageBus(fetchEvt, clientId) {
  const client = new Client(clientId);
  clients[clientId] = client;

  fetchEvt.respondWith(
    // XXX - request.formData() not available
    fetchEvt.request.text().then(function(formDataAsText) {
      const jsonBody = parseForm(formDataAsText);
      jsonBody.forEach((reg) => {
        client.subscribe(reg.k, parseInt(reg.v));
      });
      return null;
    }).then(function() {
      if (client.hasData()) {
        return client.respond();
      } else {
        return client.makePromise();
      }
    })
  );
}

function restartPolling() {
  if (currentRequest) {
    currentRequest.abort();
  }
  currentRequest = new XMLHttpRequest();

}

function parseForm(text) {
  const result = [];
  text.split('&').forEach(function(part) {
    const keyValue = part.split('=');
    result.push({k: decodeURIComponent(keyValue[0]), v: decodeURIComponent(keyValue[1])});
  });
  return result;
}