# Shelf Speaker (Cast receiver)

A small Google Cast receiver for Shelf, a home-screen app for Google TV. It plays a live audio
stream sent from a TV on the same home network, with a small buffer, so a Cast speaker can play
along with the TV.

- Connects only to private home-network addresses (10.x, 172.16–31.x, 192.168.x), and only when a
  Cast sender on that network asks.
- Loads no code except Google's Cast receiver library, enforced by a Content Security Policy.
- Collects and sends nothing anywhere; status goes back only to the sender that connected.
