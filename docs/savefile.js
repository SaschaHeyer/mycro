/* Mycro: the ONE way a page hands the grower a file (I134).
   Every download on this site used to revoke its blob URL one second after the click.
   Chrome on Android asks "Download file?" in a sheet before it reads the blob, so a grower
   who takes more than a second to press Download gets "Download failed" and taps again
   (two separate visitors did exactly that on 2026-09-26, 2 and 3 taps each). Worse, Start
   fresh saves its backup and then opens a confirm, so the copy could die behind the dialog
   while the dialog said it was safe. The URL now lives for ten minutes, long past any
   dialog a person leaves open. A few kilobytes held that long cost nothing. */
(function(){
  var KEEP_MS = 10 * 60 * 1000;
  window.MYCRO_SAVE_KEEP_MS = KEEP_MS;
  window.mycroSaveFile = function(name, text, type){
    var url = URL.createObjectURL(new Blob([text], {type: type || 'application/octet-stream'}));
    var a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, KEEP_MS);
    return url;
  };
})();
