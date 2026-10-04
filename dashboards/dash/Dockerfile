FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# no root needed; HOME=/tmp so anything the framework writes goes to the /tmp emptyDir
USER 65534:65534
ENV PYTHONUNBUFFERED=1 HOME=/tmp
EXPOSE 8050
CMD ["gunicorn", "--bind=0.0.0.0:8050", "--workers=1", "--threads=8", "app:server"]
