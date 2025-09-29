FROM node:18
RUN apt-get update && apt-get install -y postfix
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN echo "relayhost =" >> /etc/postfix/main.cf
RUN echo "myhostname = otp-server-lkg66281.onrender.com" >> /etc/postfix/main.cf
RUN echo "mynetworks = 127.0.0.0/8" >> /etc/postfix/main.cf
EXPOSE 3000 8080
CMD service postfix start && node server.js