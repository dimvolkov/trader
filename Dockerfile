FROM nginx:alpine
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY index.html /usr/share/nginx/html/index.html
COPY scanner.html /usr/share/nginx/html/scanner.html
COPY settings.html /usr/share/nginx/html/settings.html
COPY lightweight-charts.js /usr/share/nginx/html/lightweight-charts.js
EXPOSE 3000
ENTRYPOINT ["/docker-entrypoint.sh"]
