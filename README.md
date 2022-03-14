# x32-reflector

A simple module that polls x32 to send all parameter changes and then redirects them to a set of configured clients. This allows you to go beyond the 4 client limit imposed by X32 and also allow you to use X32 with software like QLab that has restrictions on OSC data sources.

Built at the request of Andrew

## Configuration

A summary of the config file is provided but it should be relatively self explanatory

|Key|Meaning|
|---|---|
|`udp`|The ip address and port the UDP server should bind to. This is used for bidirectional communication with X32 but there are no requirements on what this port needs to be. IP address should be used to specify the adapter if multiple are present or 0.0.0.0 to receive on all|
|`http`|The ip address and port the HTTP server should bind to. The HTTP server is used to add and manage clients which will receive the forwarded OSC packets from X32. Same meaning as `udp` - interface and port it should be accessible on|
|`x32`|The ip address and port on the network for X32 - this will be used to direct `/xremote` packets|
|`timeout`|How long, in minutes, a client should remain on the list before being removed automatically. This is suggested to be a long value (such as 1440 for 24 hours) so that clients are not removed part way through a show. |

## Timeouts

Clients are configured to timeout at a certain point so that the system is not sending packets repeatedly to clients that do not exist. The timeout value should be set high enough to prevent clients from timing out during shows. Additionally it is recommended that clients use the 'Renew' button just before a show which will reset the countdown and make sure they don't expire mid-show.

## Known Problems

This system does not verify that X32 is online so while running it will constantly send `/xremote` packets every 9 seconds. See issue #1 for more info

## Web Interface

The web interface has been designed to be as simple as possible. Simply enter the IP address of the client and the port on which you wish to receive packets and press the button. The page should refresh and your client will be listed and will begin receiving packets. To stop receiving packets, just press Delete or to stop your client timing out just press Renew. The page should refresh every 10 seconds to keep the countdown up to date and the client list accurate. There is a countdown to when each client will timeout which can be used to make sure important clients are not being removed at the wrong time