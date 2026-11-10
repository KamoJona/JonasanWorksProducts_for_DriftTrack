<#
  HTML ページをパスワードで暗号化し、ブラウザでパスワードを入れると表示されるページを作ります。
  暗号: PBKDF2-SHA256 で鍵を作り、AES-256-CBC で暗号化、HMAC-SHA256 で改ざんとパスワード違いを検出します。
  ブラウザ側は Web Crypto API で復号します（https か、手元のファイルとして開いたときに動きます）。

  使い方（普通の PowerShell ウィンドウで実行）:
    powershell -ExecutionPolicy Bypass -File tools\encrypt-page.ps1 -InFile <元の HTML> -OutFile docs\<公開するファイル名>.html
  パスワードは画面で 2 回入力します。画面には表示されず、どこにも保存されません。
#>
param(
  [Parameter(Mandatory = $true)][string]$InFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$Iterations = 600000
)
$ErrorActionPreference = 'Stop'

function ConvertTo-Plain([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

if ($env:PAGE_PASSWORD_FOR_TEST) {
  $pw = $env:PAGE_PASSWORD_FOR_TEST   # 動作確認用。本番では使わない
} else {
  $p1 = ConvertTo-Plain (Read-Host 'パスワード' -AsSecureString)
  $p2 = ConvertTo-Plain (Read-Host 'パスワード（確認のためもう一度）' -AsSecureString)
  if ($p1 -ne $p2) { throw 'パスワードが一致しません。もう一度実行してください。' }
  if ($p1.Length -lt 12) { throw 'パスワードは 12 文字以上にしてください（16 文字以上を推奨）。' }
  $pw = $p1
}

$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$salt = New-Object byte[] 16; $rng.GetBytes($salt)
$iv   = New-Object byte[] 16; $rng.GetBytes($iv)

Write-Host '鍵を作っています（数秒かかります）...'
$kdf = New-Object Security.Cryptography.Rfc2898DeriveBytes($pw, $salt, $Iterations, [Security.Cryptography.HashAlgorithmName]::SHA256)
$keys = $kdf.GetBytes(64)
$encKey = [byte[]]$keys[0..31]
$macKey = [byte[]]$keys[32..63]

$aes = [Security.Cryptography.Aes]::Create()
$aes.Mode = [Security.Cryptography.CipherMode]::CBC
$aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
$aes.Key = $encKey
$aes.IV = $iv
$plain = [IO.File]::ReadAllBytes((Resolve-Path $InFile))
$ct = $aes.CreateEncryptor().TransformFinalBlock($plain, 0, $plain.Length)

$ms = New-Object IO.MemoryStream
$ms.Write($iv, 0, $iv.Length); $ms.Write($ct, 0, $ct.Length)
$hmac = New-Object Security.Cryptography.HMACSHA256 -ArgumentList (,$macKey)
$mac = $hmac.ComputeHash($ms.ToArray())

$template = @'
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>パスワードが必要です</title>
<style>
:root{--bg:#f6f7f8;--fg:#16191d;--muted:#5d6670;--line:#dde1e6;--surface:#fff;--accent:#1f4fd1;--on-accent:#fff;--err:#a8141c}
@media (prefers-color-scheme: dark){:root{--bg:#111418;--fg:#e8ebef;--muted:#9aa3ad;--line:#2b3139;--surface:#181c21;--accent:#7d9dff;--on-accent:#0d1530;--err:#ff9a9e;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font-family:"Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",system-ui,sans-serif}
form{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:380px;width:100%;display:grid;gap:14px}
h1{font-size:18px;margin:0;line-height:1.4}
p{margin:0;color:var(--muted);font-size:14px}
input{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
input:focus,button:focus{outline:2px solid var(--accent);outline-offset:2px}
button{font:inherit;font-weight:700;padding:10px;border:0;border-radius:8px;background:var(--accent);color:var(--on-accent);cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.msg{color:var(--err);font-size:13px;min-height:1.3em;margin:0}
</style>
</head>
<body>
<form id="f">
<h1>この資料はパスワードで保護されています</h1>
<p>共有されたパスワードを入力してください。</p>
<input id="pw" type="password" autocomplete="current-password" required autofocus aria-label="パスワード">
<button id="b" type="submit">開く</button>
<p class="msg" id="m" role="alert"></p>
</form>
<script>
const D={salt:"__SALT__",iv:"__IV__",ct:"__CT__",mac:"__MAC__",iter:__ITER__};
const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
document.getElementById("f").addEventListener("submit",async ev=>{
  ev.preventDefault();
  const btn=document.getElementById("b"),msg=document.getElementById("m");
  if(!window.crypto||!crypto.subtle){msg.textContent="このブラウザでは開けません。https のページとして開いてください。";return;}
  btn.disabled=true;msg.textContent="確認しています…";
  try{
    const base=await crypto.subtle.importKey("raw",new TextEncoder().encode(document.getElementById("pw").value),"PBKDF2",false,["deriveBits"]);
    const bits=new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",salt:b64(D.salt),iterations:D.iter,hash:"SHA-256"},base,512));
    const iv=b64(D.iv),ct=b64(D.ct);
    const data=new Uint8Array(iv.length+ct.length);data.set(iv);data.set(ct,iv.length);
    const macKey=await crypto.subtle.importKey("raw",bits.slice(32),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
    if(!(await crypto.subtle.verify("HMAC",macKey,b64(D.mac),data))){msg.textContent="パスワードが違います。";btn.disabled=false;return;}
    const encKey=await crypto.subtle.importKey("raw",bits.slice(0,32),{name:"AES-CBC"},false,["decrypt"]);
    const html=new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-CBC",iv},encKey,ct));
    document.open();document.write(html);document.close();
  }catch(e){msg.textContent="開けませんでした。もう一度お試しください。";btn.disabled=false;}
});
</script>
</body>
</html>
'@

$out = $template.Replace('__SALT__', [Convert]::ToBase64String($salt)).
  Replace('__IV__', [Convert]::ToBase64String($iv)).
  Replace('__CT__', [Convert]::ToBase64String($ct)).
  Replace('__MAC__', [Convert]::ToBase64String($mac)).
  Replace('__ITER__', [string]$Iterations)

$outPath = [IO.Path]::GetFullPath((Join-Path (Get-Location) $OutFile))
[IO.File]::WriteAllText($outPath, $out, (New-Object Text.UTF8Encoding $false))
Write-Host "暗号化したページを作りました: $outPath"
Write-Host 'ブラウザで開いて、パスワードで表示できることを確認してください。'
