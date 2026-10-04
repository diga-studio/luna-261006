import unittest


class SkeletonTest(unittest.TestCase):
    def test_import(self):
        import dlp_stream

        self.assertTrue(hasattr(dlp_stream, "Scanner"))


if __name__ == "__main__":
    unittest.main()
