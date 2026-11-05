cp .env.example .env
# Populate KEEPER_PRIVATE_KEY and webhook URLs
docker-compose up -d --build
docker-compose logs -f chimp-keeper