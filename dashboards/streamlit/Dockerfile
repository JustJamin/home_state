FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# no root needed; HOME=/tmp so anything the framework writes goes to the /tmp emptyDir
USER 65534:65534
ENV PYTHONUNBUFFERED=1 HOME=/tmp
EXPOSE 8501
CMD ["streamlit", "run", "app.py", "--server.port=8501", "--server.address=0.0.0.0", "--server.headless=true", "--browser.gatherUsageStats=false"]
