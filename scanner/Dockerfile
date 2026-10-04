FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY payload.py db.py scanner.py ./

# BlueZ's D-Bus policy lets any user talk to org.bluez, so no root needed
RUN useradd --system --uid 10001 scanner
USER scanner

ENV PYTHONUNBUFFERED=1 \
    DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
CMD ["python", "scanner.py"]
