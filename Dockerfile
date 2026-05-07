FROM mcr.microsoft.com/playwright:latest

WORKDIR /app
COPY package.json .
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev
COPY scrape.mjs scraper-server.mjs ./

CMD ["node", "scraper-server.mjs"]
