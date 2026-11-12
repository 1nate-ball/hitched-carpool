// Decode and re-encode before uploading: a small square JPEG without the original file's EXIF metadata.
export async function prepareProfilePhoto(file) {
  if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose a photo smaller than 10 MB.');
  let image;
  try { image = await createImageBitmap(file); }
  catch { throw new Error('This photo could not be opened. Try another JPG, PNG, or WebP.'); }
  try {
    const side = Math.min(image.width,image.height);
    if (!side) throw new Error('Choose a photo with a valid size.');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(side,640);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(image,(image.width-side)/2,(image.height-side)/2,side,side,0,0,canvas.width,canvas.height);
    const photo = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',0.86));
    if (!photo || photo.size > 1048576) throw new Error('This photo could not be resized. Try a smaller photo.');
    return photo;
  } finally { image.close(); }
}
