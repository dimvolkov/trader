FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY scanner.html /usr/share/nginx/html/scanner.html
COPY settings.html /usr/share/nginx/html/settings.html
COPY journal.html /usr/share/nginx/html/journal.html
COPY design-test.html /usr/share/nginx/html/design-test.html
COPY lightweight-charts.js /usr/share/nginx/html/lightweight-charts.js
EXPOSE 3000
