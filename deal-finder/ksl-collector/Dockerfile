# Apify base image with Node 20 + Playwright + Chromium preinstalled ("playwright": "*" uses the bundled version).
FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" && (npm list --omit=dev --all || true)

COPY --chown=myuser . ./
CMD npm start --silent
