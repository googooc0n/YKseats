const fs = require('fs');
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
  keyFile: 'google-credentials.json',
  scopes: ['https://www.googleapis.com/auth/drive']
});

const drive = google.drive({ version: 'v3', auth });

// 여기에 복사한 ID 입력
const LOG_FILE_ID = '1VVdq6hLPqXINkRla0JEeerzHBKJMijyh';

async function downloadLog(localPath) {
  const dest = fs.createWriteStream(localPath);
  const res = await drive.files.get(
    { fileId: LOG_FILE_ID, alt: 'media' },
    { responseType: 'stream' }
  );
  await new Promise((resolve, reject) => {
    res.data.pipe(dest).on('end', resolve).on('error', reject);
  });
}

async function uploadLog(localPath) {
  await drive.files.update({
    fileId: LOG_FILE_ID,
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: fs.createReadStream(localPath)
    }
  });
}

module.exports = { downloadLog, uploadLog };