/*jshint bitwise: false*/

/**
  Message Bus functionality.

  @class MessageBus
  @namespace Discourse
  @module Discourse
**/
window.MessageBus = (function() {
  // http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
  var callbacks, clientId, failCount, shouldLongPoll, queue, responseCallbacks, uniqueId, baseUrl;
  var me, started, stopped, longPoller, pollTimeout, paused, later, workerBroken;

  uniqueId = function() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r, v;
      r = Math.random() * 16 | 0;
      v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };

  clientId = uniqueId();
  responseCallbacks = {};
  callbacks = [];
  queue = [];
  interval = null;
  failCount = 0;
  baseUrl = "/";
  paused = false;
  later = [];
  workerBroken = false;

  var hiddenProperty;

  $.each(["","webkit","ms","moz","ms"], function(index, prefix){
    var check = prefix + (prefix === "" ? "hidden" : "Hidden");
    if(document[check] !== undefined ){
      hiddenProperty = check;
    }
  });

  var isHidden = function() {
    if (hiddenProperty !== undefined){
      return document[hiddenProperty];
    } else {
      return !document.hasFocus;
    }
  };

  shouldLongPoll = function() {
    return me.alwaysLongPoll || !isHidden();
  };

  var totalAjaxFailures = 0;
  var totalAjaxCalls = 0;
  var lastAjax;

  var processMessages = function(messages) {
    var gotData = false;
    if (!messages) return false; // server unexpectedly closed connection

    $.each(messages, function(_,message) {
      gotData = true;
      $.each(callbacks, function(_, callback) {
        if (callback.channel === message.channel) {
          callback.last_id = message.message_id;
          try {
            callback.func(message.data);
          } catch(e) {
            if (console.log) {
              console.log("MESSAGE BUS FAIL: callback " + callback.channel +  " caused exception " + e.message);
            }
          }
        }
        if (message.channel === "/__status") {
          if (message.data[callback.channel] !== undefined) {
            callback.last_id = message.data[callback.channel];
          }
        }
        if (message.channel === "/__flush") {
          callback.last_id = -1;
        }
        if (message.channel === "/__worker_broken") {
          console.warn("MessageBus: ServiceWorker indicated it is broken, bypassing");
          workerBroken = true;
        }
      });
    });

    return gotData;
  };

  longPoller = function(poll,data){
    var gotData = false;
    var aborted = false;
    lastAjax = new Date();
    totalAjaxCalls += 1;

    var query = [];
    if (!shouldLongPoll() || !me.enableLongPolling) {
      query.push("dlp=t");
    }
    if (workerBroken) {
      query.push("worker=f");
    }

    return me.ajax({
      url: me.baseUrl + "message-bus/" + me.clientId + "/poll?" + query.join('&'),
      data: data,
      cache: false,
      dataType: 'json',
      type: 'POST',
      headers: {
        'X-SILENCE-LOGGER': 'true'
      },
      success: function(messages) {
        failCount = 0;
        if (paused) {
          if (messages) {
            $.each(messages, function(_,message) {
              later.push(messages);
            });
          }
        } else {
          gotData = processMessages(messages);
        }
      },
      error: function(xhr, textStatus, err) {
        if(textStatus === "abort") {
          aborted = true;
        } else {
          failCount += 1;
          totalAjaxFailures += 1;
        }
      },
      complete: function() {
        var interval;
        try {
          if (gotData || aborted) {
            interval = 100; // MIN_REQUEST_INTERVAL
          } else {
            interval = me.callbackInterval;
            if (failCount > 2) {
              interval = interval * failCount;
            } else if (!shouldLongPoll()) {
              interval = me.backgroundCallbackInterval;
            }
            if (interval > me.maxPollInterval) {
              interval = me.maxPollInterval;
            }

            interval -= (new Date() - lastAjax);

            if (interval < 100) { // MIN_REQUEST_INTERVAL
              interval = 100; // MIN_REQUEST_INTERVAL
            }
          }
        } catch(e) {
          if(console.log && e.message) {
            console.log("MESSAGE BUS FAIL: " + e.message);
          }
        }

        pollTimeout = setTimeout(function(){pollTimeout=null; poll();}, interval);
        me.longPoll = null;
      }
    });
  };

  me = {
    enableLongPolling: true,
    callbackInterval: 15000,
    backgroundCallbackInterval: 60000,
    maxPollInterval: 3 * 60 * 1000,
    callbacks: callbacks,
    clientId: clientId,
    alwaysLongPoll: false,
    baseUrl: baseUrl,
    // TODO we can make the dependency on $ and jQuery conditional
    // all we really need is an implementation of ajax
    ajax: $.ajax,

    diagnostics: function(){
      console.log("Stopped: " + stopped + " Started: " + started);
      console.log("Current callbacks");
      console.log(callbacks);
      console.log("Total ajax calls: " + totalAjaxCalls + " Recent failure count: " + failCount + " Total failures: " + totalAjaxFailures);
      console.log("Last ajax call: " + (new Date() - lastAjax) / 1000  + " seconds ago") ;
    },

    pause: function() {
      paused = true;
    },

    resume: function() {
      paused = false;
      processMessages(later);
      later = [];
    },

    stop: function() {
      stopped = true;
      started = false;
    },

    // Start polling
    start: function(opts) {
      var poll, delayPollTimeout;

      if (started) return;
      started = true;
      stopped = false;

      if (!opts) opts = {};

      poll = function() {
        var data;

        if(stopped) {
          return;
        }

        if (callbacks.length === 0) {
          if(!delayPollTimeout) {
            delayPollTimeout = setTimeout(function(){ delayPollTimeout = null; poll();}, 500);
          }
          return;
        }

        data = {};
        $.each(callbacks, function(_,callback) {
          data[callback.channel] = callback.last_id;
        });

        me.longPoll = longPoller(poll,data);
      };


      // monitor visibility, issue a new long poll when the page shows
      if(document.addEventListener && 'hidden' in document){
        me.visibilityEvent = document.addEventListener('visibilitychange', function(){
          if(!document.hidden && !me.longPoll && pollTimeout){
            clearTimeout(pollTimeout);
            pollTimeout = null;
            poll();
          }
        });
      }

      poll();
    },

    // Subscribe to a channel
    subscribe: function(channel, func, lastId) {

      if(!started && !stopped){
        me.start();
      }

      if (typeof(lastId) !== "number" || lastId < -1){
        lastId = -1;
      }
      callbacks.push({
        channel: channel,
        func: func,
        last_id: lastId
      });
      if (me.longPoll) {
        return me.longPoll.abort();
      }
    },

    // Unsubscribe from a channel
    unsubscribe: function(channel, func) {
      // TODO proper globbing
      var glob;
      if (channel.indexOf("*", channel.length - 1) !== -1) {
        channel = channel.substr(0, channel.length - 1);
        glob = true;
      }
      callbacks = $.grep(callbacks,function(callback) {
        var keep;

        if (glob) {
          keep = callback.channel.substr(0, channel.length) !== channel;
        } else {
          keep = callback.channel !== channel;
        }

        if(!keep && func && callback.func !== func){
          keep = true;
        }

        return keep;
      });

      if (me.longPoll) {
        return me.longPoll.abort();
      }
    }
  };

  return me;
})();
