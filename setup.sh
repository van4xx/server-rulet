#!/bin/bash

# Обновление системы
apt-get update
apt-get upgrade -y

# Установка необходимых пакетов
apt-get install -y curl build-essential git certbot nginx

# Установка Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# Создание директорий
mkdir -p /opt/ruletka/server
mkdir -p /var/log/ruletka

# Настройка прав доступа
touch /var/log/ruletka.log
touch /var/log/ruletka.error.log
chown -R root:root /opt/ruletka
chmod -R 755 /opt/ruletka
chmod 644 /var/log/ruletka.log
chmod 644 /var/log/ruletka.error.log

# Копирование файлов приложения
cp -r ./* /opt/ruletka/server/

# Установка зависимостей приложения
cd /opt/ruletka/server
npm install

# Получение SSL сертификата
certbot certonly --standalone -d ruletka.top --non-interactive --agree-tos --email your@email.com

# Настройка systemd сервиса
cp ruletka.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ruletka
systemctl start ruletka

# Настройка firewall
ufw allow 80
ufw allow 443
ufw allow 3478/tcp
ufw allow 3478/udp

# Установка и настройка TURN сервера
apt-get install -y coturn
systemctl stop coturn
cat > /etc/turnserver.conf << EOL
listening-port=3478
tls-listening-port=5349
listening-ip=$(curl -s ifconfig.me)
external-ip=$(curl -s ifconfig.me)
realm=ruletka.top
server-name=ruletka.top
fingerprint
lt-cred-mech
user=ruletka:ruletka123
total-quota=100
stale-nonce=600
cert=/etc/letsencrypt/live/ruletka.top/fullchain.pem
pkey=/etc/letsencrypt/live/ruletka.top/privkey.pem
cipher-list="ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384"
no-stdout-log
EOL

# Настройка TURN как системного сервиса
systemctl enable coturn
systemctl start coturn

# Проверка статуса сервисов
systemctl status ruletka
systemctl status coturn

echo "Setup completed. Check the service status above." 