SHELL := /bin/bash
COMPOSE_DEV  := docker compose -f docker-compose.yml -f docker-compose.dev.yml
COMPOSE_PROD := docker compose -f docker-compose.yml -f docker-compose.prod.yml

.PHONY: ayuda arriba abajo logs migrar api-sh db-sh reconstruir desplegar respaldo limpiar

ayuda:
	@echo "  make arriba        levanta db, redis, api y trabajador (desarrollo)"
	@echo "  make abajo         los apaga"
	@echo "  make logs          sigue los logs"
	@echo "  make migrar        aplica las migraciones a mano"
	@echo "  make db-sh         abre psql en la base"
	@echo "  make reconstruir   rebuild completo"
	@echo "  make respaldo      pg_dump local a respaldos/"
	@echo "  make desplegar     sube a DigitalOcean (./desplegar.sh)"

arriba:
	$(COMPOSE_DEV) up -d db redis api trabajador
	@echo "API en http://localhost:3000 · frontend: cd web && npm run dev"

abajo:
	$(COMPOSE_DEV) down

logs:
	$(COMPOSE_DEV) logs -f api trabajador

migrar:
	$(COMPOSE_DEV) exec api node src/migrar.js

api-sh:
	$(COMPOSE_DEV) exec api sh

db-sh:
	$(COMPOSE_DEV) exec db psql -U monitoreo -d monitoreo

reconstruir:
	$(COMPOSE_DEV) build --no-cache
	$(COMPOSE_DEV) up -d

respaldo:
	@mkdir -p respaldos
	$(COMPOSE_DEV) exec -T db pg_dump -U monitoreo monitoreo | gzip > respaldos/local-$$(date +%Y%m%d-%H%M%S).sql.gz
	@echo "listo en respaldos/"

desplegar:
	./desplegar.sh

limpiar:
	$(COMPOSE_DEV) down -v
