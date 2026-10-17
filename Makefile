.PHONY: all help db-build db-up db db-down db-logs bot dev clean bg-start bg-restart bg-stop bg-logs

DB_IMAGE ?= telegraf-postgres
DB_CONTAINER ?= telegraf_postgres
DB_PORT ?= 5433

all: help

help:
	@echo Comandi disponibili:
	@echo   make db-up      - Costruisce e avvia il database PostgreSQL (Docker) su porta $(DB_PORT)
	@echo   make db-down    - Ferma il container del database PostgreSQL
	@echo   make db-logs    - Mostra i log del database PostgreSQL
	@echo   make bot        - Avvia il bot Telegram con 'node index.js'
	@echo   make dev        - Avvia prima il database e poi lancia il bot
	@echo   make bg-start   - Avvia (o riavvia) 'make dev' in background
	@echo   make bg-restart - Riavvia il bot e il DB in background dopo un aggiornamento
	@echo   make bg-stop    - Ferma il processo del bot in background
	@echo   make bg-logs    - Mostra i log del processo in background in tempo reale
	@echo   make clean      - Rimuove il container del database

# Costruzione immagine PostgreSQL personalizzata
db-build:
	docker build -t $(DB_IMAGE) .

# Avvio del container PostgreSQL in background sulla porta 5433
db-up: db-build
	@docker rm -f $(DB_CONTAINER) 2>nul || exit 0
	docker run -d \
		--name $(DB_CONTAINER) \
		-p $(DB_PORT):5432 \
		-v telegraf_pgdata:/var/lib/postgresql/data \
		$(DB_IMAGE)
	@echo Database PostgreSQL avviato con successo su localhost:$(DB_PORT)

db: db-up

# Arresto del container PostgreSQL
db-down:
	docker stop $(DB_CONTAINER)

# Log del database PostgreSQL
db-logs:
	docker logs -f $(DB_CONTAINER)

# Avvio del bot su Windows Host
bot:
	node index.js

# Avvia prima il DB e poi il bot
dev: db-up bot

# Avvia o riavvia il processo in background
bg-start:
	wscript.exe "C:\_SORGENTI\TeleBot\start-bot-bg.vbs"
	@echo Processo avviato in background. Usa 'make bg-logs' per vedere i log.

bg-restart: bg-start

# Ferma il processo node del bot in background
bg-stop:
	@powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $$_.CommandLine -match 'index\.js' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"
	@echo Processo bot in background terminato.

# Visualizza i log del bot in background in tempo reale
bg-logs:
	@powershell -NoProfile -Command "if (!(Test-Path bot.log)) { New-Item bot.log -ItemType File | Out-Null }; Get-Content bot.log -Wait -Tail 30"

# Pulizia container
clean:
	docker rm -f $(DB_CONTAINER) 2>nul || exit 0
