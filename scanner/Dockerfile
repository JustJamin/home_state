FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY payload.py db.py scanner.py ./

# BlueZ's D-Bus policy lets any user talk to org.bluez, so no root needed.
# The host's dbus-daemon drops connections from uids it can't resolve, so
# use one that exists on the host: nobody.
USER 65534:65534

ENV PYTHONUNBUFFERED=1 \
    DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
CMD ["python", "scanner.py"]
