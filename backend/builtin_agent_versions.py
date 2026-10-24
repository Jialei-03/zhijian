"""SHA-256 of shipped built-ins and their former initialization/restore output.

Collected from git log -p -- backend/agents/*.md (8e450c9, 2014a6f, 8fd70e5).
Keep old entries when changing a built-in; no Git history is needed at runtime.
"""

BUILTIN_HASHES = {
    "advisor": {
        # 8e450c9 original
        "d7f8ab4e724a551b2042f27cbf2a9d4ded07cba70b4e1377370525c2b563e332",
        # 8e450c9 initialized
        "9ece2446a6db1e6f94d02a2466bed83d75507a8ef7d2250dab1fc01cce9eff7d",
        # 8e450c9 restored
        "d966d1fbf374b65206d62e7a4f60cfc9dc7f4a77b87dd99472733e56f1a21741",
        # 2014a6f original
        "b9b2a73d633f0453dfa00ece643d91e4857b780f799fc9e45afcaa25a2bfee2e",
        # 2014a6f initialized
        "bc650687039a38cb1d76c24133e9051e1e8c51c9b7953de2dfe6d464d8a0ed5f",
        # 2014a6f restored
        "e1ea1a2d8b094c5d98f8fd96b6306e8ea82f8ace165d43d1f08d69eb85dc6cd2",
    },
    "distiller": {
        # 8e450c9 original
        "fc24606e09e82d78f7c5634c07afbb78bb2aa71b5c7e0cc767e9bf1348d2d494",
        # 8e450c9 initialized
        "f3f258fc7fd1e3e7ca80c9902540a92b4879062d825241a39e351c2871ecbb25",
        # 8e450c9 restored
        "4f3dc4748c942163a82059383c8d0cd48fc36f97584d864cdbe5fb8680f08650",
        # 2014a6f original
        "4ebdadd13b70ab5982d1a2accaaf5a01fc8cf49d86ad6657a552fa4b1c5a9401",
        # 2014a6f initialized
        "b871d2cffb532451291e877cd48f25fcb6bf06280a9d4e1847aa6cb625da3216",
        # 2014a6f restored
        "04392c27c6730cb78796d7beb2844477aa2ec4815df64bf9c2e1e5bac4fe92d5",
    },
    "executor": {
        # 8e450c9 original
        "32bb2d960f49659342ae7de8902db88e5c289a39fce2376a1e6029b75a77bf89",
        # 8e450c9 initialized
        "c4fee6f3eccae2c342fc1792315b863c0a46d2caced5d154d65c44263b09bcdb",
        # 8e450c9 restored
        "c474f5c4bec9275156c5e063f9379ffc38db985ca76547eea3e65e79583c0502",
        # 2014a6f original
        "dc58dc0b1f1a2e9b113d6beb0d2558babe64d0a57579d80b72c4502b716806f8",
        # 2014a6f initialized
        "d16df3c3fb67a5e91ba6f4ee7868c7ddc106fa0ce45d77b15098b0a2757dd2e3",
        # 2014a6f restored
        "7cde7c6a7a7d7c0ca4f304f6bbe8ed56b28e562f1a0b2b7c1cd4ff72549b8a89",
    },
    "librarian": {
        # 8e450c9 original
        "2efe8c0e5f420b66994d1423611993b6094793eb9e68d6be48693d4e00180339",
        # 8e450c9 initialized
        "31699711e21b9289254007224037cec193fdc0e2f83f589cc97c6ec2af2f0eb7",
        # 8e450c9 restored
        "bb800739cf063842b097067adcd367d8d64fc4b98e2533423e0a92c3b3d08851",
        # 2014a6f original
        "6cb3a8f136673a924e9f4c94b41e0217338fd9452c6b20b2564c216496438199",
        # 2014a6f initialized
        "184a405823c3e0b8a95c832062b2bd89093fc3dde8001fcde805b264f9057e6a",
        # 2014a6f restored
        "ffe86c18f0dbd9f477c9a516ab72702282dcce76c7db690c7c36ef3498e85a23",
        # 8fd70e5 original
        "9ade3b1cef39656bd189cbe075a1139c8b4a56d5d24fdc7e65a01e82209af9c4",
        # 8fd70e5 initialized
        "dc0bc7d74f79d736978cf2f39074ecb3329966339d3021bca5d272bd85a83680",
        # 8fd70e5 restored
        "4b3a2da7d9a5d49f5aaa27ec8cedbfdede6efe2b1661ee168b935cbc680606e0",
    },
    "reviewer": {
        # 8e450c9 original
        "dc3bdbf1f23c2dcb834fc1a4847b318fd02bb441a73380fb0b47764fda8f2992",
        # 8e450c9 initialized
        "bea7397b824a504ab02096ad34786da405520e65535ee95fada601ba66ee3ec4",
        # 8e450c9 restored
        "cca7dbcdfecfb4898ae1c5242305bccb10e4263e611c3759b95ad264a473b266",
        # 2014a6f original
        "00f44a2a2c83f5d54d73ce9ecc43dfd3ab95ec2002a1fca690c97e52611dfa1f",
        # 2014a6f initialized
        "b82d5715c9eed5fe6026d9c4366395ee82585f432ee4d741b0a93123f7ce3a3b",
        # 2014a6f restored
        "59ad0e188faf002b72c05a50b5885f0079eac5dee204baee960680f3fc7418c2",
        # 8fd70e5 original
        "6401ba3ce8bf2ad43b6bc0e7821d1c9876c42f7da9ffe708eab779aa8f60fa28",
        # 8fd70e5 initialized
        "42c345387ba185449a3790e66af6672e6b03f69f904f639cd971eef1d38d89a5",
        # 8fd70e5 restored
        "afa653a74d1f96e7256cb87e6e25093e3881f438c5e79fa19b744904e47af4ac",
    },
    "writer": {
        # 8e450c9 original
        "38e4411f916f182c767bdc465480c8c54cdbd03f8c15cae45e34e66712569eb2",
        # 8e450c9 initialized
        "2cfbf1bf554384a406184a34d511c3977f1680b3dc0147d3e2b9911e8c16855b",
        # 8e450c9 restored
        "09620f0afe9225bcb7814a2165075aba181efdde05b8f6f4c0974f1b7bb72bb5",
        # 2014a6f original
        "2b0ce6bbeb94acf7a897a46cd6c76651b3b87b76fdec9d692730ee518d51db7e",
        # 2014a6f initialized
        "fb989eb641a30a3de19c6dd7d1d4f5a4e17f2fe0f9743fbef862c50e0bed80af",
        # 2014a6f restored
        "2fb8e9cbf2f5806f5ef02603dfca91485c748779babad19227a8f03cd53e800b",
        # 8fd70e5 original
        "f4ad08ea6f5bcf3a4cc4723b19c0cb7b8a7a348f13da21955f5840b0bfd1ae23",
        # 8fd70e5 initialized
        "af6667a6de86274ae048dd902cc9ad7493716093c3887ac310a6f0936fff81af",
        # 8fd70e5 restored
        "b47d5f5fdd71d37df7fe8b744697455691c181864309c13db26fba2d2bbf3c30",
    },
}
