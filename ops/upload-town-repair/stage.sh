set -e
ST=/tmp/argus-town-stage; rm -rf $ST; mkdir -p $ST
rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports /opt/2906-system/backend/ $ST/
mkdir -p $ST/node_modules $ST/test
python3 /root/upload-town-repair/patch.py $ST
cp /root/upload-town-repair/stage-check.js $ST/test/
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2906_backend | awk '{print $1}')
ENVF=$(mktemp); chmod 600 $ENVF
docker exec 2906_backend env | grep -E '^(POSTGRES_|DB_|PG)' > $ENVF || true
docker run --rm --network "$NET" --env-file $ENVF -v $ST:/app:ro -v /opt/2906-system/backend/node_modules:/app/node_modules:ro -w /app --entrypoint timeout 2906-system-backend 120 node test/stage-check.js /app/handlers/uploadListing.js 2>&1 | grep -v '^{"level\|^\[20' | cut -c1-200
rm -f $ENVF; rm -rf $ST
