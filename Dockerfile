# 互換性の高い ubuntu 20.04 ベースのイメージを使用
FROM mcr.microsoft.com/playwright:v1.40.0-focal

# 2. 作業ディレクトリを /app に設定
WORKDIR /app

# 3. package.json と package-lock.json をコピー
COPY package*.json ./

# 4. 依存ライブラリをインストール
RUN npm install

# 5. プロジェクトの全ファイルをコピー
COPY . .

# 6. ボットを起動
CMD ["node", "index.js"]
