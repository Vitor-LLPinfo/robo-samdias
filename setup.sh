#!/bin/bash
set -e

echo "======================================"
echo " Instalação Robô Sam Dias - Linux VPS"
echo "======================================"

# ---- Node.js ----
if ! command -v node &> /dev/null; then
  echo "[1/5] Instalando Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[1/5] Node.js já instalado: $(node -v)"
fi

# ---- Diretório ----
echo "[2/5] Criando /opt/robo-samdias..."
sudo mkdir -p /opt/robo-samdias/templates
sudo cp robo.js /opt/robo-samdias/
[ -f config.json ] || cp config.example.json config.json
sudo cp config.json /opt/robo-samdias/
sudo cp templates/*.txt /opt/robo-samdias/templates/

# ---- Permissões ----
sudo chown -R $USER:$USER /opt/robo-samdias
chmod +x /opt/robo-samdias/robo.js

# ---- Token ----
echo ""
echo "[3/5] Configurando token do Apresenta.me..."
echo ""
echo "  Cole o token abaixo (do console do Apresenta.me):"
echo "  window.api?.defaults?.headers?.common?.Authorization"
echo ""
read -p "  Token (Bearer eyJ...): " TOKEN
if [ -z "$TOKEN" ]; then
  echo "  AVISO: Token não informado. Edite /opt/robo-samdias/config.json depois."
else
  # Escapa aspas para o JSON
  TOKEN_ESCAPED=$(echo "$TOKEN" | sed 's/"/\\"/g')
  sed -i "s|COLE_SEU_TOKEN_AQUI|$TOKEN_ESCAPED|g" /opt/robo-samdias/config.json
  echo "  Token configurado."
fi

# ---- Systemd service ----
echo "[4/5] Criando serviço systemd..."
sudo tee /etc/systemd/system/robo-samdias.service > /dev/null <<EOF
[Unit]
Description=Robo Sam Dias Imoveis
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/robo-samdias
ExecStart=$(which node) /opt/robo-samdias/robo.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# ---- Inicia ----
echo "[5/5] Iniciando serviço..."
sudo systemctl daemon-reload
sudo systemctl enable robo-samdias
sudo systemctl start robo-samdias

echo ""
echo "======================================"
echo " Instalação concluída!"
echo "======================================"
echo ""
echo " Comandos úteis:"
echo "   Ver logs ao vivo:  sudo journalctl -u robo-samdias -f"
echo "   Status:            sudo systemctl status robo-samdias"
echo "   Reiniciar:         sudo systemctl restart robo-samdias"
echo "   Parar:             sudo systemctl stop robo-samdias"
echo "   Editar config:     nano /opt/robo-samdias/config.json"
echo ""
echo " Log de envios:  /opt/robo-samdias/robo_log.csv"
echo " Estado:         /opt/robo-samdias/robo_processados.json"
echo ""
