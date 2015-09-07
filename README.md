# MessageBus

A reliable, robust messaging bus for Ruby processes and web clients built on Redis.

MessageBus implements a Server to Server channel based protocol and Server to Web Client protocol (using polling or long-polling)


## Installation

Add this line to your application's Gemfile:

    gem 'message_bus'

And then execute:

    $ bundle

Or install it yourself as:

    $ gem install message_bus

Add it to your JS bundle:

    //= require message-bus

## Usage

Server to Server messaging

```ruby
message_id = MessageBus.publish "/channel", "message"

# in another process / spot

MessageBus.subscribe "/channel" do |msg|
  # block called in a backgroud thread when message is recieved
end

MessageBus.backlog "/channel", id
# returns all messages after the id


# messages can be targetted at particular users or groups
MessageBus.publish "/channel", user_ids: [1,2,3], group_ids: [4,5,6]

# messages can be targetted at particular clients (using MessageBus.clientId)
MessageBus.publish "/channel", client_ids: ["XXX","YYY"]

# message bus determines the user ids and groups based on env

MessageBus.user_id_lookup do |env|
  # return the user id here
end

MessageBus.group_ids_lookup do |env|
  # return the group ids the user belongs to
  # can be nil or []
end


MessageBus.client_filter("/channel") do |user_id, message|
  # return message if client is allowed to see this message
  # allows you to inject server side filtering of messages based on arbitrary rules
  # also allows you to override the message a clients will see
  # be sure to .dup the message if you wish to change it
end

```

### Multisite support

MessageBus can be used in an environment that hosts multiple sites by multiplexing channels. To use this mode

```ruby
# define a site_id lookup method
MessageBus.site_id_lookup do
  some_method_that_returns_site_id_string
end

# you may post messages just to this site
MessageBus.publish "/channel", "some message"

# you may publish messages to ALL sites using the /global/ prefix
MessageBus.publish "/global/channel", "will go to all sites"
```

### JavaScript
JavaScript can listen on any channel (and receive notification via polling or long polling).

Include it via: `<script src="message-bus.js" type="text/javascript"></script>`

Or include it in your JS bundle:
```js
//= require message-bus
```

Usage:

```javascript
MessageBus.start(); // call once at startup

// how often do you want the callback to fire in ms
MessageBus.callbackInterval = 500;
MessageBus.subscribe("/channel", function(data) {
  // data shipped from server
});

```

If you have a ServiceWorker, the `message-bus-worker.js` script can multiplex the requests from multiple tabs.

```js
// From an existing ServiceWorker

importScripts(
  '/assets/message-bus-worker.js'
);

// Or:

//= require message-bus-worker
```

## Configuration

### Redis

You can configure redis setting in `config/initializers/message_bus.rb`, like

```ruby
MessageBus.redis_config = { url: "redis://:p4ssw0rd@10.0.1.1:6380/15" }
```
The redis client message_bus uses is [redis-rb](https://github.com/redis/redis-rb), so you can visit it's repo to see what options you can configure.

### Forking/threading app servers

If you're using a forking or threading app server and you're not getting immediate updates from published messages, you might need to reconnect Redis in your app server config:

#### Passenger
```ruby
# Rails: config/application.rb or config.ru
if defined?(PhusionPassenger)
  PhusionPassenger.on_event(:starting_worker_process) do |forked|
    if forked
      # We're in smart spawning mode.
      MessageBus.after_fork
    else
      # We're in conservative spawning mode. We don't need to do anything.
    end
  end
end
```

#### Puma
```ruby
# path/to/your/config/puma.rb
on_worker_boot do
  MessageBus.after_fork
end
```

#### Unicorn
```ruby
# path/to/your/config/unicorn.rb
after_fork do |server, worker|
  MessageBus.after_fork
end
```

## Similar projects

Faye - http://faye.jcoglan.com/

## Contributing

1. Fork it
2. Create your feature branch (`git checkout -b my-new-feature`)
3. Commit your changes (`git commit -am 'Added some feature'`)
4. Push to the branch (`git push origin my-new-feature`)
5. Create new Pull Request
