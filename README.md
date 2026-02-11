# 🎮 ICPC: Desafío Arcade

Buk es sponsor de la [ICPC](https://icpc.global/regionals/finder/TCP) y trae un Arcade.
Pero esta vez el desafío no es usarlo: es crear el videojuego que estará disponible durante el evento.

**Tu misión:** ¡Construye el mejor juego de arcade usando Phaser 3 (librería JS para juegos) que correrá en nuestra máquina arcade física!

---

## 🏆 Premios

### Primer Lugar
- Gift Card de **$100 USD** en Apple
- Tu juego estará disponible en la máquina arcade durante el evento

### Segundo Lugar
- Tu juego estará disponible en la máquina arcade durante el evento

---

## 📋 Restricciones

Tu juego debe cumplir con estas restricciones técnicas:

### Límite de Tamaño
- ✅ **Máximo 50KB después de minificación** (antes de gzip)
- El código del juego se minifica automáticamente - enfócate en escribir buen código

### Restricciones de Código
- ✅ **Solo JavaScript vanilla puro** - Sin `import` o `require`
- ✅ **Sin URLs externas** - Sin `http://`, `https://`, o `//` (excepto URIs `data:` para base64)
- ✅ **Sin llamadas de red** - Sin `fetch`, `XMLHttpRequest`, o APIs similares
- ✅ **Ambiente sandboxed** - El juego corre en un iframe sin acceso a internet

### Lo Que SÍ Puedes Usar
- ✅ **Phaser 3** (v3.87.0) - Cargado externamente vía CDN (no cuenta en el límite de tamaño)
- ✅ **Imágenes codificadas en base64** - Usando URIs `data:`
- ✅ **Gráficos generados proceduralmente** - Usando la API de Graphics de Phaser
- ✅ **Tonos de audio generados** - Usando la Web Audio API de Phaser
- ✅ **Renderizado y efectos basados en Canvas**

# 🕹️ Controles

¡Tu juego correrá en un gabinete arcade real con joysticks y botones físicos!

## Mapeo de Botones del Arcade

El gabinete arcade envía códigos de teclas específicos cuando se presionan los botones:

**Jugador 1:**
- **Joystick**: `P1U`, `P1D`, `P1L`, `P1R` (Arriba, Abajo, Izquierda, Derecha)
- **Diagonales del Joystick**: `P1DL`, `P1DR` (Abajo-Izquierda, Abajo-Derecha)
- **Botones de Acción**: `P1A`, `P1B`, `P1C` (fila superior) / `P1X`, `P1Y`, `P1Z` (fila inferior)
- **Start**: `START1`

**Jugador 2:**
- **Joystick**: `P2U`, `P2D`, `P2L`, `P2R`
- **Diagonales del Joystick**: `P2DL`, `P2DR`
- **Botones de Acción**: `P2A`, `P2B`, `P2C` / `P2X`, `P2Y`, `P2Z`
- **Start**: `START2`

## Pruebas Locales

Para pruebas locales, puedes mapear estos botones arcade a teclas del teclado. El mapeo soporta **múltiples teclas por botón arcade** (útil para alternativas como WASD + Flechas). Ve `game.js` para el template completo de mapeo `ARCADE_CONTROLS`.

Por defecto:
- Jugador 1 usa **WASD** (joystick) y **U/I/O/J/K/L** (botones de acción)
- Jugador 2 usa **Flechas** (joystick) y **R/T/Y/F/G/H** (botones de acción)

💡 **Tip**: Mantén los controles simples - diseña para joystick + 1-2 botones de acción para la mejor experiencia arcade!

---

## ⭐ Criterios de Evaluación

¿Quieres saber cómo se evaluarán los juegos? Revisa los **Criterios de Evaluación** completos en:

👉 **[https://buk-arcade-challenge.icpc.cl/criterios](https://buk-arcade-challenge.icpc.cl/criterios)**

Conoce qué aspectos como la sensación arcade, rejugabilidad, entretención, claridad visual, pulido y creatividad se tomarán en cuenta al evaluar tu juego.

---

## ⏰ Deadline y Envío

**Deadline:** 25 de febrero de 2026 a las 23:59 (hora Chile)

### Cómo Enviar

Enviar tu proyecto es fácil:

1. **Guarda tus cambios** - Asegúrate de que `game.js`, `metadata.json` y `cover.png` estén listos
   - **Importante:** Tu juego debe incluir un archivo `cover.png` personalizado que muestre tu juego
2. **Git push** - Sube tu código a tu repositorio:
   ```bash
   git add .
   git commit -m "Envío final"
   git push
   ```

¡Eso es todo! 🎉

**Tu juego aparecerá automáticamente en:** [https://buk-arcade-challenge.icpc.cl/](https://buk-arcade-challenge.icpc.cl/)

El sistema sincroniza automáticamente los forks del template y los publica en el sitio.

---

## 🚀 Inicio Rápido

### 1. Instalar Dependencias
```bash
pnpm install
```

### 2. Iniciar Servidor de Desarrollo
```bash
pnpm dev
```
Esto inicia un servidor en `http://localhost:3000` con verificación de restricciones en vivo.

### 3. Construye Tu Juego
- **Edita `game.js`** - Escribe el código de tu juego arcade
- **Actualiza `metadata.json`** - Define el nombre y descripción de tu juego
- **Crea `cover.png`** - Diseña una imagen de portada PNG para tu juego
- **Observa el servidor de desarrollo** - Muestra actualizaciones en vivo del tamaño de archivo y restricciones

---

## 🤖 Vibecodea Tu Juego

¡Este desafío está diseñado para **vibecoding** - construir tu juego con asistencia de IA!

### Lo Que Hemos Configurado Para Ti

- **`AGENTS.md`** - Instrucciones pre-configuradas para que tu IDE (Cursor, Windsurf, etc.) entienda el desafío
- **`docs/phaser-quick-start.md`** - Guía de referencia rápida para Phaser 3
- **`docs/phaser-api.md`** - Documentación completa de la API de Phaser 3

Tu agente de IA ya sabe:
- ✅ Todas las restricciones del desafío
- ✅ Cómo usar Phaser 3 efectivamente
- ✅ Mejores prácticas para mantenerse bajo los 50KB
- ✅ Qué archivos editar (solo `game.js` y `metadata.json`)

### Cómo Vibecodear

¡Simplemente dile a tu asistente de IA qué juego quieres construir! Por ejemplo:

> "Crea un clon de Space Invaders con enemigos coloridos"
> 
> "Construye un juego estilo flappy bird con gráficos procedurales"
> 
> "Haz un juego de breakout con power-ups"

¡Tu IA manejará la implementación, manteniendo todo dentro de las restricciones automáticamente!
