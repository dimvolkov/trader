FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY landing.html /usr/share/nginx/html/landing.html
COPY index.html /usr/share/nginx/html/index.html
COPY scanner.html /usr/share/nginx/html/scanner.html
COPY settings.html /usr/share/nginx/html/settings.html
COPY journal.html /usr/share/nginx/html/journal.html
COPY strategy.html /usr/share/nginx/html/strategy.html
COPY ai-agent.html /usr/share/nginx/html/ai-agent.html
COPY crypto.html /usr/share/nginx/html/crypto.html
COPY candles.html /usr/share/nginx/html/candles.html
COPY design-test.html /usr/share/nginx/html/design-test.html
COPY lightweight-charts.js /usr/share/nginx/html/lightweight-charts.js
COPY login.html /usr/share/nginx/html/login.html
COPY register.html /usr/share/nginx/html/register.html
COPY reset.html /usr/share/nginx/html/reset.html
COPY reset-apply.html /usr/share/nginx/html/reset-apply.html
COPY verify.html /usr/share/nginx/html/verify.html
EXPOSE 3000
