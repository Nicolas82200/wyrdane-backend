# /var/www/wyrdane-backend/backend/Dockerfile
# Multi-stage build : compile le TS puis ne garde que le nécessaire en prod

# ---- Stage 1 : build ----
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build
# -> produit /app/dist

# ---- Stage 2 : production ----
FROM node:20-slim AS production
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
# Le dossier public (assets servis directement par Express) - à garder si présent
COPY public ./public

EXPOSE 3000

# Utilisateur non-root pour la sécurité
RUN useradd --uid 1001 --create-home nodeuser
USER nodeuser

CMD ["node", "dist/index.js"]
