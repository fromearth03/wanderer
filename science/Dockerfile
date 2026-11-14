FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
RUN useradd -u 10001 -m app && mkdir -p /data/cache && chown app /data/cache
USER app
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8091/health',timeout=4)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091", "--workers", "1"]
