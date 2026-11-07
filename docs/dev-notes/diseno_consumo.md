# Consumo: dónde se van los tokens y qué hacer — diseño (borrador 2026-11-07, sin construir)

## Idea
Orchestra ya lee los .jsonl de cada sesión de Claude (tokens por tipo, subagentes, TTL de caché).
Falta **atribuir** el gasto a su causa y **sugerir** con pruebas y ahorro estimado.

## Datos medidos (2026-11-07, máquina del usuario)
- `~/.claude/projects` = **39 GB**, 6547 .jsonl (solo la cuenta por defecto; hay 4 cuentas más).
  → el escaneo histórico tiene que ser incremental, con índice, en segundo plano y por defecto
  solo los últimos N días. (Aparte: tanto espacio en disco → sugerencia `cleanupPeriodDays`.)
- Primera petición de una sesión normal: cache_creation 33k + cache_read 23k ≈ **56k de base fija**
  antes de hacer nada (instrucciones, herramientas, MCP, CLAUDE.md, MEMORY.md).
- Cada mensaje trae `usage` {input, cache_creation, cache_read, output, thinking}, modelo, hora.

## Modelo de atribución (la clave)
Lo que entra al contexto no se paga una vez: se escribe en caché una vez y **se relee en cada
petición siguiente** hasta compactar o acabar. Coste real de un bloque de t tokens que entra en la
petición k de una sesión de N peticiones:
  coste = t·w_write + t·(N−k)·w_read
Así un Read de 38k al principio de una sesión de 200 peticiones pesa mucho más que uno al final.
- t por bloque: delta de contexto entre peticiones consecutivas (input+cache_read+cache_creation)
  menos la salida anterior, repartido entre los bloques nuevos por caracteres.
- Pesos w por modelo (input, escritura de caché 5 min / 1 h, lectura de caché, salida) de una tabla
  de precios **a verificar al construir** (skill claude-api), no de memoria. Se muestra en % del
  total y «equivalente en tokens de entrada», no en euros (es suscripción).

Categorías: base fija · Read (por fichero) · Bash (por comando) · Grep/Glob · MCP (por servidor y
herramienta) · imágenes/capturas · resultado de subagente · system-reminder/hooks/memoria ·
tus mensajes · salida · thinking. Y por quién: hilo principal vs cada subagente (por tipo:
obrero, peon, Explore…), por modelo, por proyecto, por cuenta.

Eventos: **caché rota** (cache_creation grande no explicado por contenido nuevo; causa probable:
hueco > TTL = caducada · cambio de modelo · prefijo cambiado), **compactación**, **arranque en frío**.

## Pantallas
1. **Por sesión** (cajón del terminal): barra apilada por categoría; «Top 10 lo más caro» con coste
   real y enlace al mensaje; línea de tamaño de contexto con marcas (compactaciones, caché rota).
2. **Global** (pestaña Consumo): hoy / 7 días / 30 días, por proyecto, cuenta, modelo, principal vs
   subagentes y tipo de subagente; tendencia semana a semana.
3. **Sugerencias**: lista de reglas con prueba, ahorro estimado y el caso concreto. Se pueden
   descartar («ya lo sé») y no vuelven para ese caso.

## Reglas de sugerencia (iniciales; varias salen del CLAUDE.md del usuario)
- Read de fichero > 30 KB entero → «usa rangos o grep» (coste real X).
- Mismo fichero leído varias veces en la sesión.
- Salida de Bash larga sin filtrar → «filtra con grep/tail».
- Capturas/imágenes en el hilo principal (> 4-6) → «delégalas a un crítico».
- Subagente > 300k reanudado con SendMessage → «lanza otro con el estado».
- fork con contexto padre > 150k → «el fork hereda todo».
- Subagente mecánico en Opus → «peon/Haiku».
- Caché rota a menudo / arranques en frío tras > TTL → auto-compact o volver antes (chip de caducidad).
- Base fija grande: desglose (MEMORY.md, cada MCP — enlaza con el gestor de MCP —, CLAUDE.md).
- Sesión > 450k o que cambió de tema → «abre sesión nueva».
- Historial en disco enorme → `cleanupPeriodDays`.
Cada regla: umbral ajustable, prueba (qué mensaje, cuántos tokens), ahorro = coste real evitable.
Todo marcado como **estimación**.

## Cerrar el círculo
- Botón **«Copiar informe para tu IA»**:
  Markdown compacto con un párrafo de instrucciones al principio («analiza y propón el mejor curso
  de acción…») y TODOS los detalles: periodo, totales y coste por día/cuenta/proyecto/modelo, base
  fija media y su desglose (CLAUDE.md, MEMORY.md, MCP, skills), roturas de caché, compactaciones,
  top de lo más caro, subagentes (por tipo), permissionMode de las sesiones (está en entradas
  type:user del jsonl). Sin secretos; rutas personales tapadas (`~`, `<proyecto>`). Muestra el
  tamaño en tokens del propio informe antes de copiar.
- Exportar el mismo informe a fichero.
- Herramienta MCP de Orchestra `usage_report` (solo lectura) para que la propia sesión lo consulte.

## Privacidad y rendimiento
- Todo local. El índice guarda números, nombres de herramienta y rutas; no contenido (como mucho
  80 caracteres de vista previa, opcional).
- Índice en ORCHESTRA_DATA_DIR (offset por fichero + agregados por petición); hilo en segundo plano
  a baja prioridad; primer escaneo con progreso y cancelable.

## Fuera (por ahora)
- Codex/opencode: Codex guarda sesiones con eventos de tokens, pero sin verificar formato → fase
  posterior. Solo Windows.

## Fases
- C1 Índice incremental + atribución por petición y por bloque (Rust), tests con .jsonl recortados
  reales (anonimizados) y comprobación de que las sumas cuadran con `usage`.
- C2 Vista por sesión (cajón) + top 10.
- C3 Vista global + escaneo histórico.
- C4 Motor de sugerencias + descartar.
- C5 Exportar informe + `usage_report` MCP.
