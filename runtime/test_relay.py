import socket
import threading
import time
import unittest
from unittest.mock import patch

import relay


class RelayTests(unittest.TestCase):
    def test_half_closed_request_can_receive_delayed_streamed_response(self):
        with socket.socket() as upstream:
            upstream.bind(("127.0.0.1", 0))
            upstream.listen()

            def answer():
                connection, _ = upstream.accept()
                with connection:
                    request = b""
                    while data := connection.recv(1024):
                        request += data
                    time.sleep(0.05)
                    connection.sendall(request)
                    time.sleep(0.05)
                    connection.sendall(b"-complete")

            producer = threading.Thread(target=answer, daemon=True)
            producer.start()
            with patch("sys.argv", ["relay.py", "127.0.0.1", str(upstream.getsockname()[1])]):
                with relay.Server(("127.0.0.1", 0), relay.Relay) as server:
                    serving = threading.Thread(target=server.serve_forever, daemon=True)
                    serving.start()
                    try:
                        with socket.create_connection(server.server_address, timeout=2) as client:
                            client.sendall(b"request")
                            client.shutdown(socket.SHUT_WR)
                            response = b""
                            while data := client.recv(1024):
                                response += data
                        self.assertEqual(response, b"request-complete")
                    finally:
                        server.shutdown()
                        serving.join(timeout=2)
            producer.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
