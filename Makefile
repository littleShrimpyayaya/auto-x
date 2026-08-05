# auto-x common targets
.PHONY: up down stop logs build install migrate config ps

up:
	./scripts/start.sh

# Remove containers/network (keeps named volume pgdata unless -v)
down:
	docker compose down

# SIGTERM stop only (containers remain); matches scripts/stop.sh
stop:
	./scripts/stop.sh

logs:
	./scripts/logs.sh

build:
	docker compose build

install:
	export PATH="$$HOME/.local/bin:$$PATH"; pnpm install

migrate:
	export PATH="$$HOME/.local/bin:$$PATH"; pnpm db:migrate

config:
	docker compose config

ps:
	docker compose ps
