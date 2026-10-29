FROM node:24-alpine AS deps

# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm@10.24.0

# Install dependencies based on the preferred package manager
COPY package.json pnpm-lock.yaml .
RUN \
if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
else echo "Lockfile not found." && exit 1; \
fi

# Rebuild the source code only when needed
FROM node:24-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@10.24.0
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_NODE_ADDRESS
ARG NEXT_PUBLIC_CONTRACT_ADDRESS
ARG NEXT_PUBLIC_EXPLORER
ARG NEXT_PUBLIC_IPFS_UPLOAD_ADDRESS
ARG NEXT_PUBLIC_IPFS_GETAWAY
ARG NEXT_PUBLIC_LAUNCHPAD_ADDRESS
ARG NEXT_PUBLIC_VOUCHER_API
ARG NEXT_PUBLIC_RIVRDEX_APP
ENV NEXT_PUBLIC_NODE_ADDRESS=${NEXT_PUBLIC_NODE_ADDRESS}
ENV NEXT_PUBLIC_CONTRACT_ADDRESS=${NEXT_PUBLIC_CONTRACT_ADDRESS}
ENV NEXT_PUBLIC_EXPLORER=${NEXT_PUBLIC_EXPLORER}
ENV NEXT_PUBLIC_IPFS_UPLOAD_ADDRESS=${NEXT_PUBLIC_IPFS_UPLOAD_ADDRESS}
ENV NEXT_PUBLIC_IPFS_GETAWAY=${NEXT_PUBLIC_IPFS_GETAWAY}
ENV NEXT_PUBLIC_LAUNCHPAD_ADDRESS=${NEXT_PUBLIC_LAUNCHPAD_ADDRESS}
ENV NEXT_PUBLIC_VOUCHER_API=${NEXT_PUBLIC_VOUCHER_API}
ENV NEXT_PUBLIC_RIVRDEX_APP=${NEXT_PUBLIC_RIVRDEX_APP}
# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

# Production image, copy all the files and run next
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

ARG NEXT_PUBLIC_NODE_ADDRESS
ARG NEXT_PUBLIC_CONTRACT_ADDRESS
ARG NEXT_PUBLIC_EXPLORER
ARG NEXT_PUBLIC_IPFS_UPLOAD_ADDRESS
ARG NEXT_PUBLIC_IPFS_GETAWAY
ARG NEXT_PUBLIC_LAUNCHPAD_ADDRESS
ARG NEXT_PUBLIC_VOUCHER_API
ARG NEXT_PUBLIC_RIVRDEX_APP
ENV NEXT_PUBLIC_NODE_ADDRESS=${NEXT_PUBLIC_NODE_ADDRESS}
ENV NEXT_PUBLIC_CONTRACT_ADDRESS=${NEXT_PUBLIC_CONTRACT_ADDRESS}
ENV NEXT_PUBLIC_EXPLORER=${NEXT_PUBLIC_EXPLORER}
ENV NEXT_PUBLIC_IPFS_UPLOAD_ADDRESS=${NEXT_PUBLIC_IPFS_UPLOAD_ADDRESS}
ENV NEXT_PUBLIC_IPFS_GETAWAY=${NEXT_PUBLIC_IPFS_GETAWAY}
ENV NEXT_PUBLIC_LAUNCHPAD_ADDRESS=${NEXT_PUBLIC_LAUNCHPAD_ADDRESS}
ENV NEXT_PUBLIC_VOUCHER_API=${NEXT_PUBLIC_VOUCHER_API}
ENV NEXT_PUBLIC_RIVRDEX_APP=${NEXT_PUBLIC_RIVRDEX_APP}
# Uncomment the following line in case you want to disable telemetry during runtime.
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]
