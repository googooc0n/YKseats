param(
  [string]$Message = "Auto commit"
)

# 프로젝트 루트로 이동 (스크립트가 있는 곳)
Set-Location -Path $PSScriptRoot

# 모든 변경사항 스테이징
git add .

# 커밋
git commit -m $Message

# 푸시 (main 브랜치에)
git push -u origin main
