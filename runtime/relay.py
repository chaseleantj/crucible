"""Guest loopback forwarding for CLI provider URLs; no credentials handled here."""
import select
import socket
import socketserver
import sys


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        with socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=10) as remote:
            remote.settimeout(None)
            peers = {self.request: remote, remote: self.request}
            while peers:
                readable, _, _ = select.select(list(peers), [], [])
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        peers.pop(source).shutdown(socket.SHUT_WR)
                    else:
                        peers[source].sendall(data)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", int(sys.argv[2])), Relay) as server:
        server.serve_forever()
