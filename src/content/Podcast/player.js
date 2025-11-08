(() => {
  // ---- Minimal configuration ----
  const defaultPlaylist = [
    { title: "Modular Ethics Ep 1", artist: "Artaius", src: "Podcast Ep 1.mp3" },
  ];

  // ---- Elements ----
  const audio = document.getElementById("audio");
  const titleEl = document.getElementById("title");
  const metaEl  = document.getElementById("meta");
  const curEl   = document.getElementById("cur");
  const durEl   = document.getElementById("dur");
  const seekEl  = document.getElementById("seek");
  const volEl   = document.getElementById("vol");
  const listEl  = document.getElementById("list");
  const dropEl  = document.getElementById("drop");
  const pickerEl= document.getElementById("picker");
  const btnPrev = document.getElementById("prev");
  const btnPlay = document.getElementById("play");
  const btnNext = document.getElementById("next");
  const btnLoop = document.getElementById("loop");
  const btnShuffle = document.getElementById("shuffle");

  // ---- State ----
  const qs = new URLSearchParams(location.search);
  const srcParam = qs.get("src");
  const titleParam = qs.get("title");
  const artistParam = qs.get("artist");

  let playlist = srcParam
    ? [{ title: titleParam || srcParam.split("/").pop(), artist: artistParam || "", src: srcParam }]
    : defaultPlaylist.slice();

  let index = 0;
  let shuffle = false;

  // ---- Helpers ----
  const fmt = t => !isFinite(t) ? "0:00" : `${Math.floor(t/60)}:${Math.floor(t%60).toString().padStart(2,"0")}`;

  function renderList() {
    listEl.innerHTML = "";
    playlist.forEach((t, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "row";
      b.innerHTML = `<span>${t.title || ("Track " + (i+1))}</span><span class="tiny">${t.artist || ""}</span>`;
      b.addEventListener("click", () => load(i, true));
      if (i === index) b.classList.add("active");
      listEl.appendChild(b);
    });
  }

  function load(i, autoplay=false) {
    if (!playlist.length) return;
    index = ((i % playlist.length) + playlist.length) % playlist.length;
    const t = playlist[index];
    audio.src = t.src;
    titleEl.textContent = t.title || t.src.split("/").pop();
    metaEl.textContent  = t.artist || new URL(t.src, location.href).href;
    Array.from(listEl.children).forEach((el, j) => el.classList.toggle("active", j === index));

    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: titleEl.textContent, artist: t.artist || "", album: "", artwork: []
      });
    }
    if (autoplay) audio.play().catch(()=>{});
  }

  function nextTrack() {
    if (shuffle && playlist.length > 1) {
      let j; do { j = Math.floor(Math.random()*playlist.length); } while (j === index);
      load(j, true);
    } else {
      load(index + 1, true);
    }
  }

  // ---- Wire up controls ----
  btnPlay.addEventListener("click", () => audio.paused ? audio.play() : audio.pause());
  audio.addEventListener("play",  () => btnPlay.textContent = "⏸️");
  audio.addEventListener("pause", () => btnPlay.textContent = "▶️");
  btnPrev.addEventListener("click", () => load(index - 1, true));
  btnNext.addEventListener("click", nextTrack);

  btnLoop.addEventListener("click", () => {
    audio.loop = !audio.loop;
    btnLoop.style.outline = audio.loop ? "2px solid var(--accent)" : "none";
  });

  btnShuffle.addEventListener("click", () => {
    shuffle = !shuffle;
    btnShuffle.style.outline = shuffle ? "2px solid var(--accent)" : "none";
  });

  volEl.addEventListener("input", () => audio.volume = +volEl.value);

  seekEl.addEventListener("input", () => {
    if (audio.duration) audio.currentTime = (+seekEl.value / 1000) * audio.duration;
  });

  audio.addEventListener("timeupdate", () => {
    if (audio.duration) seekEl.value = Math.floor((audio.currentTime / audio.duration) * 1000);
    curEl.textContent = fmt(audio.currentTime);
  });

  audio.addEventListener("durationchange", () => durEl.textContent = fmt(audio.duration));
  audio.addEventListener("ended", nextTrack);

  // ---- Drag & drop / picker (optional but handy) ----
  function addFiles(files) {
    const items = Array.from(files).filter(f => f.type === "audio/mpeg" || f.name.toLowerCase().endsWith(".mp3"));
    const urls = items.map(f => ({ title: f.name.replace(/\.mp3$/i,""), artist: "Local file", src: URL.createObjectURL(f) }));
    if (!urls.length) return;
    playlist = playlist.length ? playlist.concat(urls) : urls;
    renderList();
    load(playlist.length - urls.length, true);
  }

  pickerEl.addEventListener("change", e => addFiles(e.target.files));
  ["dragenter","dragover"].forEach(evt => dropEl.addEventListener(evt, e => { e.preventDefault(); e.dataTransfer.dropEffect="copy"; dropEl.classList.add("drag"); }));
  ["dragleave","drop"].forEach(evt => dropEl.addEventListener(evt, e => { e.preventDefault(); dropEl.classList.remove("drag"); }));
  dropEl.addEventListener("drop", e => addFiles(e.dataTransfer.files));

  // ---- Media Session actions (mobile lockscreen) ----
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => load(index - 1, true));
    navigator.mediaSession.setActionHandler("nexttrack", nextTrack);
  }

  // ---- Init ----
  renderList();
  if (playlist.length) load(0, false);
})();