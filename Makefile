# auto-x common targets
.PHONY: up down logs build install migrate config ps

up:
	./scripts/start.sh

down:
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
