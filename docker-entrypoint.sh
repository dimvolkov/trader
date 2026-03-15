#!/bin/sh
envsubst '${EXECUTOR_URL} ${EXECUTOR_API_SECRET}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
