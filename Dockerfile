# Use uma imagem Node.js oficial
FROM node:18-alpine

# Definir diretório de trabalho
WORKDIR /app

# Copiar package.json e package-lock.json (se existir)
COPY package*.json ./

# Instalar dependências
RUN npm ci --omit=dev

# Copiar o código da aplicação
COPY . .

# Criar diretório para banco de dados
RUN mkdir -p /app/data

# Expor a porta
EXPOSE $PORT

# Comando para executar a aplicação
CMD ["npm", "start"]
