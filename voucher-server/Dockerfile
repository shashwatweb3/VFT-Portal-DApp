FROM node:24-alpine

RUN apk add --no-cache libc6-compat

WORKDIR /app

RUN npm install -g pnpm@10.24.0

COPY package.json pnpm-lock.yaml ./
# tsx is a devDependency but is the runtime for this service, so install it too.
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY idl ./idl

ENV NODE_ENV=production
ENV PORT=4010
EXPOSE 4010

CMD ["pnpm", "start"]
