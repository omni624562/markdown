//! 最小的 ZIP 寫入（只用「不壓縮」的儲存方式）：.docx 就是一個 ZIP 檔。
//! 圖片本來就壓縮過，文字部分不大，不壓縮也不影響 Word 開啟，還省下一個壓縮套件。

fn crc32(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, v) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *v = c;
        }
        t
    });
    !data.iter().fold(!0u32, |c, &b| {
        table[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8)
    })
}

#[derive(Default)]
pub struct ZipWriter {
    out: Vec<u8>,
    central: Vec<u8>,
    count: u16,
}

impl ZipWriter {
    pub fn add(&mut self, name: &str, data: &[u8]) {
        let crc = crc32(data);
        let offset = self.out.len() as u32;
        let size = data.len() as u32;
        let name = name.as_bytes();
        // 時間固定為 1980-01-01，同樣的內容匯出的檔案也一樣。
        let (time, date) = (0u16, 0x21u16);
        // 本機檔案標頭
        self.out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        for v in [20u16, 0x0800, 0, time, date] {
            self.out.extend_from_slice(&v.to_le_bytes());
        }
        for v in [crc, size, size] {
            self.out.extend_from_slice(&v.to_le_bytes());
        }
        self.out
            .extend_from_slice(&(name.len() as u16).to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out.extend_from_slice(name);
        self.out.extend_from_slice(data);
        // 中央目錄
        self.central
            .extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        for v in [20u16, 20, 0x0800, 0, time, date] {
            self.central.extend_from_slice(&v.to_le_bytes());
        }
        for v in [crc, size, size] {
            self.central.extend_from_slice(&v.to_le_bytes());
        }
        for v in [name.len() as u16, 0, 0, 0, 0] {
            self.central.extend_from_slice(&v.to_le_bytes());
        }
        self.central.extend_from_slice(&0u32.to_le_bytes());
        self.central.extend_from_slice(&offset.to_le_bytes());
        self.central.extend_from_slice(name);
        self.count += 1;
    }

    pub fn finish(mut self) -> Vec<u8> {
        let start = self.out.len() as u32;
        let size = self.central.len() as u32;
        self.out.extend_from_slice(&self.central);
        self.out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        for v in [0u16, 0, self.count, self.count] {
            self.out.extend_from_slice(&v.to_le_bytes());
        }
        self.out.extend_from_slice(&size.to_le_bytes());
        self.out.extend_from_slice(&start.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes());
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn writes_entries() {
        let mut z = ZipWriter::default();
        z.add("a.txt", b"hello");
        z.add("b/c.xml", b"<x/>");
        let bytes = z.finish();
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        let end = bytes.len() - 22;
        assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
        assert_eq!(u16::from_le_bytes([bytes[end + 10], bytes[end + 11]]), 2);
    }
}
