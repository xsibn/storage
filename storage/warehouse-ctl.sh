#!/usr/bin/env bash
# warehouse-ctl.sh — простой пульт управления сервером "Адресное хранение".
# Установка (один раз):
#   sudo cp warehouse-ctl.sh /usr/local/bin/warehouse
#   sudo chmod +x /usr/local/bin/warehouse
# После этого можно вызывать из любой директории просто: warehouse <команда>
#
# Если не хочется устанавливать — просто запускайте как обычный скрипт:
#   bash warehouse-ctl.sh <команда>

set -euo pipefail

APP_NAME="warehouse"
APP_DIR="/var/www/storage"
DOMAIN="storage.30x.ru"

c_green="\033[0;32m"; c_red="\033[0;31m"; c_yellow="\033[0;33m"; c_reset="\033[0m"
info()  { echo -e "${c_green}==>${c_reset} $*"; }
warn()  { echo -e "${c_yellow}==>${c_reset} $*"; }
error() { echo -e "${c_red}==>${c_reset} $*"; }

cmd_status() {
  info "Статус процесса ($APP_NAME):"
  pm2 describe "$APP_NAME" 2>/dev/null | grep -E "status|restarts|uptime|script path|exec cwd" || {
    error "Процесс $APP_NAME не найден в pm2"
    exit 1
  }
  echo
  info "Проверка ответа локально (curl):"
  if curl -s -o /dev/null -w "  HTTP %{http_code}, время ответа: %{time_total}s\n" "http://localhost:3000/api/health"; then
    :
  else
    error "Сервер не отвечает на localhost:3000"
  fi
}

cmd_restart() {
  info "Перезапускаю $APP_NAME через pm2..."
  pm2 restart "$APP_NAME"
  sleep 1
  cmd_status
}

cmd_stop() {
  warn "Останавливаю $APP_NAME..."
  pm2 stop "$APP_NAME"
}

cmd_start() {
  info "Запускаю $APP_NAME..."
  pm2 start "$APP_NAME"
  sleep 1
  cmd_status
}

cmd_logs() {
  LINES="${1:-50}"
  info "Последние $LINES строк лога ($APP_NAME):"
  pm2 logs "$APP_NAME" --lines "$LINES" --nostream
}

cmd_errors() {
  LINES="${1:-50}"
  info "Последние $LINES строк лога ОШИБОК ($APP_NAME):"
  pm2 logs "$APP_NAME" --lines "$LINES" --nostream --err
}

cmd_watch() {
  info "Живые логи $APP_NAME (Ctrl+C для выхода)..."
  pm2 logs "$APP_NAME"
}

cmd_health() {
  info "Полная диагностика:"
  echo
  echo "1) pm2:"
  pm2 describe "$APP_NAME" 2>/dev/null | grep -E "status|restarts|uptime" || error "pm2-процесс не найден"
  echo
  echo "2) порт 3000 (кто слушает):"
  ss -ltnp 2>/dev/null | grep 3000 || warn "никто не слушает 3000"
  echo
  echo "3) ответ node напрямую:"
  curl -s -o /dev/null -w "  http://localhost:3000 -> %{http_code}\n" http://localhost:3000 || error "нет ответа"
  echo
  echo "4) nginx:"
  systemctl is-active nginx >/dev/null 2>&1 && echo "  nginx: active" || error "  nginx не запущен!"
  nginx -t 2>&1 | tail -2
  echo
  echo "5) сертификат:"
  echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null \
    | openssl x509 -noout -dates 2>/dev/null || warn "  не удалось получить сертификат"
  echo
  echo "6) сайт снаружи (через домен):"
  curl -s -o /dev/null -w "  https://$DOMAIN -> %{http_code}\n" "https://$DOMAIN" || error "  сайт не отвечает по домену"
}

cmd_pull() {
  info "Забираю обновления из git ($APP_DIR)..."
  cd "$APP_DIR"
  git pull
  info "Ставлю зависимости (если менялись)..."
  npm install --omit=dev
  cmd_restart
}

cmd_backup() {
  TS=$(date +%Y%m%d-%H%M%S)
  DEST="/root/backups/warehouse-db-$TS.sqlite"
  mkdir -p /root/backups
  info "Бэкап базы в $DEST..."
  cp "$APP_DIR/data/"*.db "$DEST" 2>/dev/null || cp "$APP_DIR/data/"*.sqlite "$DEST" 2>/dev/null || {
    error "Не нашёл файл базы в $APP_DIR/data — проверьте вручную"
    exit 1
  }
  info "Готово: $DEST"
}

print_usage() {
  cat <<EOF
Пульт управления сервером "Адресное хранение" ($DOMAIN)

Использование: warehouse <команда>

  status            — краткий статус процесса + пинг сервера
  restart           — перезапустить сервер
  stop              — остановить сервер
  start             — запустить сервер (если остановлен)
  logs [N]          — последние N строк лога (по умолчанию 50)
  errors [N]        — последние N строк лога ОШИБОК (по умолчанию 50)
  watch             — смотреть живые логи в реальном времени
  health            — полная диагностика: pm2, порт, node, nginx, сертификат, домен
  pull              — забрать обновления из git и перезапустить
  backup            — сделать копию базы данных в /root/backups

Примеры:
  warehouse restart
  warehouse logs 100
  warehouse health
EOF
}

case "${1:-}" in
  status)   cmd_status ;;
  restart)  cmd_restart ;;
  stop)     cmd_stop ;;
  start)    cmd_start ;;
  logs)     cmd_logs "${2:-50}" ;;
  errors)   cmd_errors "${2:-50}" ;;
  watch)    cmd_watch ;;
  health)   cmd_health ;;
  pull)     cmd_pull ;;
  backup)   cmd_backup ;;
  *)        print_usage ;;
esac
