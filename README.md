# Monitoreo de Rutas — Nexori System

Servicio automatizado de monitoreo de rutas de transporte de personal por WhatsApp.

**Cliente:** Viajes Azteca Oro, S.A. de C.V. · **Proveedor:** Sergio Daniel Guzmán Salas (Nexori System)

---

## Qué hace

1. Se sube el Excel semanal del cliente (`FVA-MON-01`) **sin modificarlo**.
2. El sistema programa 4 marcajes por viaje y los manda por WhatsApp a la hora exacta.
3. El conductor contesta; el marcaje 3 pide ubicación y se valida contra las geocercas.
4. Lo que no responde se pinta rojo y avisa al encargado.
5. A fin de mes se cierra el periodo y queda congelado el conteo que respalda la factura.

## La regla de negocio

```
mensualidad = renta_base + max(vehículos_activos − incluidos, 0) × extra
```

**Se cobra por vehículo, no por ruta.** Una unidad que cubre 1, 2, 3 o 4 rutas paga
exactamente lo mismo. El número de rutas se calcula y se muestra, pero **no entra en la
fórmula** — es la evidencia visible de lo que se le prometió al cliente.

Los precios viven en la tabla `parametro`, no en el código: ajustarlos es un cambio de
configuración con bitácora, no un despliegue.

## Arquitectura

```
                    ┌──────── red pública ────────┐
   internet ──443──▶│  web (nginx + SPA Vue 3)    │
                    │  api (Fastify, Node 22)     │──▶ graph.facebook.com
                    │  trabajador (BullMQ)        │
                    └──────────┬──────────────────┘
                    ┌──────────▼───── red interna (sin salida) ───┐
                    │  db (PostgreSQL 16)   redis (BullMQ, AOF)   │
                    └─────────────────────────────────────────────┘
```

| Componente | Qué hace |
|---|---|
| `app/src/servidor.js` | API REST + webhook de Meta |
| `app/src/trabajador.js` | dispara marcajes, encola envíos, levanta alertas |
| `app/src/importador/excel.js` | absorbe toda la suciedad del Excel del cliente |
| `app/src/dominio/ventana.js` | ventana de 24 h — **aquí está el margen del negocio** |
| `app/src/dominio/cobro.js` | cálculo y cierre del periodo |
| `web/` | portal Vue 3 |

## Puesta en marcha local

Requiere Docker Desktop y Node 22.

```bash
cp .env.example .env
# edita .env:  POSTGRES_PASSWORD, JWT_SECRETO, ADMIN_CORREO, ADMIN_CLAVE

make arriba                 # db, redis, api y trabajador
cd web && npm install && npm run dev
```

- Portal: http://localhost:5173/monitoreo/
- API: http://localhost:3000/salud

El portal cuelga de `/monitoreo` y no de la raíz, en desarrollo igual que en
producción, porque el dominio es de la agencia y su página va en la raíz. El
prefijo se define en `web/vite.config.js`; si se cambia, hay que cambiarlo
también en `web/Dockerfile` y en `infra/nginx/default.conf`.

Con `WA_SIMULADO=1` (predeterminado) **no se manda nada a Meta**: los mensajes se
registran en base y salen en el log. Se puede probar el flujo completo sin gastar.

> Usa el Postgres 16 del contenedor, no el que tengas instalado en Windows:
> así desarrollo y producción son la misma versión.

## Despliegue a DigitalOcean

**Una sola vez**, en un droplet Ubuntu 24.04 recién creado (2 GB):

```bash
curl -fsSL https://raw.githubusercontent.com/<usuario>/monitoreo-rutas/main/infra/provisionar.sh \
  | bash -s -- monitoreo.tudominio.com tu@correo.com
```

Instala Docker, crea el usuario `despliegue`, cierra el firewall, endurece SSH, pone
fail2ban, swap, certificado provisional, renovación de Let's Encrypt y respaldo diario.

Después, en el droplet: clonar el repo en `/opt/monitoreo-rutas` y crear ahí el `.env`
real.

**Cada despliegue**, desde tu máquina:

```bash
./desplegar.sh          # o:  make desplegar
```

Comprueba que no haya cambios sin subir, respalda la base, reconstruye, levanta,
aplica migraciones y verifica `/salud`. Si el API no responde, muestra el log y falla
sin dejar el sistema a medias.

También hay un workflow de GitHub Actions (`.github/workflows/desplegar.yml`) que hace
lo mismo al hacer push a `main` — opcional.

## Seguridad

| Control | Dónde |
|---|---|
| **Firma HMAC del webhook** (`X-Hub-Signature-256`) | `app/src/rutas/webhook.js` |
| Producción no arranca sin `WA_APP_SECRET` | `app/src/config.js` |
| Contraseñas con scrypt + comparación en tiempo constante | `app/src/dominio/claves.js` |
| Base y Redis en red Docker `internal: true`, sin puertos publicados | `docker-compose.yml` |
| Rate limit en login (Fastify + Nginx) | `auth.js`, `infra/nginx/default.conf` |
| HSTS, CSP, X-Frame-Options, sin `server_tokens` | `infra/nginx/default.conf` |
| Teléfonos y tokens ocultos en los logs | `app/src/log.js` |
| Bitácora de auditoría de toda acción sensible | tabla `bitacora` |
| Contenedores sin root, `tini` como PID 1 | `app/Dockerfile` |
| Firewall, fail2ban, SSH sin contraseña, parches automáticos | `infra/provisionar.sh` |

La verificación de la firma del webhook es el control más importante de todo el
sistema: sin ella cualquiera que conozca la URL puede inyectar ubicaciones falsas y
contaminar la evidencia.

## Lo que nunca se sube a git

`.env`, `secrets/`, `subidas/`, `respaldos/` y cualquier `.xlsx` que no sea plantilla.
Los datos de conductores son datos personales (LFPDPPP) y aquí somos **encargados** del
tratamiento, no responsables.

## Documentación

El análisis del Excel real del cliente, el modelo de cobro y el plan de trabajo están
en `../00-ANALISIS-EXCEL-CLIENTE.md` y `../docs/01-Cobro-Costos-y-Despliegue.md`.
