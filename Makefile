# auto-x common targets
.PHONY: up down stop logs build install migrate config ps

up:
	./scripts/start.sh

# Remove containers/network (keeps named volume pgdata unless -v)
down:
	-docker compose -f nginx/docker-compose.yml down
	docker compose down

# SIGTERM stop only (containers remain); matches scripts/stop.sh
stop:
	./scripts/stop.sh

logs:
	./scripts/logs.sh

nginx-up:
	mkdir -p nginx/logs nginx/web
	cp -f apps/api/public/index.html nginx/web/index.html
	docker compose -f nginx/docker-compose.yml up -d

nginx-down:
	docker compose -f nginx/docker-compose.yml down

build:
	docker compose build
	docker compose -f nginx/docker-compose.yml build 2>/dev/null || true

install:
	export PATH="$$HOME/.local/bin:$$PATH"; pnpm install

migrate:
	export PATH="$$HOME/.local/bin:$$PATH"; pnpm db:migrate

config:
	docker compose config

ps:
	docker compose ps
