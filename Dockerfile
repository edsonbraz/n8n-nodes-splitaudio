FROM n8nio/n8n:latest

USER root
# Install ffmpeg
RUN apk add --no-cache ffmpeg

RUN npm install fluent-ffmpeg -g

USER node