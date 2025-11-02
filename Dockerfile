FROM denoland/deno:1.42.0

WORKDIR /app

COPY . .

# Pré-aquecer cache das dependências para execução
RUN deno cache --unstable src/cron_worker.js

# Expor a porta padrão do Deno.serve
EXPOSE 8000

# Comando de inicialização do worker
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--unstable", "src/cron_worker.js"]