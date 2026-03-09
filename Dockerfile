FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY scanner.html /usr/share/nginx/html/scanner.html
COPY lightweight-charts.js /usr/share/nginx/html/lightweight-charts.js
EXPOSE 3000
