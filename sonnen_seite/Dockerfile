FROM python:3.12-alpine
RUN apk add --no-cache tzdata
ENV TZ=Europe/Vienna
COPY server.py card.js index.html impressum.html icon.svg /app/
WORKDIR /app
CMD ["python3", "-u", "/app/server.py"]
