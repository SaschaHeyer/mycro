# One image for everything: the admin page (default command), the visit collector and the
# appstore and rank-tracker jobs (they override the command in setup.sh).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY settings.py store.py statistics.json keywords.json* ./
COPY admin ./admin
COPY telemetry ./telemetry
COPY appstore ./appstore
COPY rank_tracker ./rank_tracker

CMD exec gunicorn --bind :$PORT --workers 1 --threads 4 --timeout 120 'admin.app:make_app()'
