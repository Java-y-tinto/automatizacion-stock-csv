# imagen hardened de Bun

FROM dhi.io/bun:1-debian13-dev

# Directorio de trabajo
WORKDIR /app

# Copiamos el package.json y el lockfile de bun
COPY package.json bun.lock ./

# Instalamos dependencias
RUN bun install

# Copiamos el resto del código
COPY . .

# Comando por defecto
CMD ["bun", "run", "index.ts"]