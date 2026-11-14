"""Kiểm thử đường hầm: server echo TCP 20000 + UDP 20001, hoặc client gửi thử.

  python test-echo.py                       # server (Ctrl-C để dừng)
  python test-echo.py --client HOST         # client
"""
import socket
import sys
import threading

TCP_PORT, UDP_PORT = 20000, 20001


def tcp_server():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", TCP_PORT))
    s.listen()
    while True:
        c, addr = s.accept()
        with c:
            data = c.recv(1024)
            print(f"TCP from {addr}: {data!r}", flush=True)
            c.sendall(b"tcp-echo:" + data)


def udp_server():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", UDP_PORT))
    while True:
        data, addr = s.recvfrom(1024)
        print(f"UDP from {addr}: {data!r}", flush=True)
        s.sendto(b"udp-echo:" + data, addr)


def client(host):
    ok = True
    try:
        with socket.create_connection((host, TCP_PORT), timeout=5) as c:
            c.sendall(b"hello")
            print("TCP:", c.recv(1024))
    except OSError as e:
        ok = False
        print("TCP FAIL:", e)
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    u.settimeout(5)
    try:
        u.sendto(b"hello", (host, UDP_PORT))
        print("UDP:", u.recvfrom(1024)[0])
    except OSError as e:
        ok = False
        print("UDP FAIL:", e)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--client":
        client(sys.argv[2])
    else:
        threading.Thread(target=udp_server, daemon=True).start()
        print(f"Listening TCP {TCP_PORT}, UDP {UDP_PORT}", flush=True)
        tcp_server()
